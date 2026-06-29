import WebSocket from 'ws';

export interface LifecycleStage {
  stage: 'Submitted' | 'Processed' | 'Confirmed' | 'Finalized' | 'Failed';
  timestamp: number;
  slot?: number;
  latencyDelta?: number; // ms from previous stage
  error?: string;
}

export interface TransactionSummary {
  signature: string;
  bundleId: string;
  tipAmount: number;
  submittedAt: number;
  stages: LifecycleStage[];
  status: 'pending' | 'success' | 'failed';
  failureReason?: string;
  processedAtSlot?: number;
  confirmedAtSlot?: number;
  finalizedAtSlot?: number;
}

export class BundyLifecycleTracker {
  private wsUrl: string;
  private activeSubscriptions: Map<string, {
    summary: TransactionSummary;
    ws: WebSocket;
    timeoutTimer: NodeJS.Timeout;
    onUpdate: (summary: TransactionSummary) => void;
  }> = new Map();

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  public trackTransaction(
    signature: string,
    bundleId: string,
    tipAmount: number,
    onUpdate: (summary: TransactionSummary) => void
  ) {
    console.log(`[Tracker] Starting tracking for transaction ${signature} (Bundle: ${bundleId})`);

    const summary: TransactionSummary = {
      signature,
      bundleId,
      tipAmount,
      submittedAt: Date.now(),
      stages: [
        { stage: 'Submitted', timestamp: Date.now() }
      ],
      status: 'pending'
    };

    // Create a dedicated WebSocket to listen to signature subscription updates
    // This allows separate commitment feeds via stream
    const ws = new WebSocket(this.wsUrl);

    // Timeout after 60 seconds (150 slots) if transaction doesn't land (expired blockhash/skipped slot)
    const timeoutTimer = setTimeout(() => {
      this.handleTimeout(signature);
    }, 60000);

    this.activeSubscriptions.set(signature, {
      summary,
      ws,
      timeoutTimer,
      onUpdate
    });

    ws.on('open', () => {
      // Subscribe to signature status at all three commitment levels: processed, confirmed, finalized
      const commitments = ['processed', 'confirmed', 'finalized'];
      
      commitments.forEach((commitment, index) => {
        const subMsg = {
          jsonrpc: '2.0',
          id: index + 10,
          method: 'signatureSubscribe',
          params: [
            signature,
            { commitment }
          ]
        };
        ws.send(JSON.stringify(subMsg));
      });
    });

    ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        if (msg.method === 'signatureNotification' && msg.params?.result?.value) {
          const value = msg.params.result.value;
          const context = msg.params.result.context;
          const slot = context?.slot;
          const err = value.err;

          if (err) {
            this.handleFailure(signature, err, slot);
          } else {
            // Determine commitment level based on subscription ID
            // ID 10 = processed, 11 = confirmed, 12 = finalized
            const subId = msg.params.subscription; // Or check standard JSON RPC ID mapping
            
            // WebSockets notify subscription results, we map based on message parameters
            // Let's inspect the message ID or match message parameters
            const reqId = msg.id;
            
            // To make sure we capture correctly, let's check which commitment level this matches
            // If the socket subscription is configured, we can update the lifecycle progression
            this.progressLifecycle(signature, slot);
          }
        }
      } catch (e) {
        console.error('[Tracker] Error parsing signature update:', e);
      }
    });

    ws.on('error', (err) => {
      console.error(`[Tracker] WebSocket error for signature ${signature}:`, err);
    });

    // Notify initial state
    onUpdate(summary);
  }

  private progressLifecycle(signature: string, slot?: number) {
    const tracking = this.activeSubscriptions.get(signature);
    if (!tracking) return;

    const { summary, onUpdate } = tracking;
    const now = Date.now();

    // Check what is the current last stage
    const currentStages = summary.stages.map(s => s.stage);

    if (!currentStages.includes('Processed')) {
      const prevTime = summary.submittedAt;
      summary.stages.push({
        stage: 'Processed',
        timestamp: now,
        slot,
        latencyDelta: now - prevTime
      });
      summary.processedAtSlot = slot;
    } else if (!currentStages.includes('Confirmed')) {
      const processedStage = summary.stages.find(s => s.stage === 'Processed');
      const prevTime = processedStage ? processedStage.timestamp : summary.submittedAt;
      summary.stages.push({
        stage: 'Confirmed',
        timestamp: now,
        slot,
        latencyDelta: now - prevTime
      });
      summary.confirmedAtSlot = slot;
    } else if (!currentStages.includes('Finalized')) {
      const confirmedStage = summary.stages.find(s => s.stage === 'Confirmed');
      const prevTime = confirmedStage ? confirmedStage.timestamp : summary.submittedAt;
      summary.stages.push({
        stage: 'Finalized',
        timestamp: now,
        slot,
        latencyDelta: now - prevTime
      });
      summary.finalizedAtSlot = slot;
      summary.status = 'success';
      
      // We reached Finalized, clean up
      this.cleanup(signature);
    }

    onUpdate({ ...summary });
  }

  private handleFailure(signature: string, err: any, slot?: number) {
    const tracking = this.activeSubscriptions.get(signature);
    if (!tracking) return;

    const { summary, onUpdate } = tracking;
    const now = Date.now();

    let classification = 'TransactionFailed';
    const errStr = JSON.stringify(err);
    if (errStr.includes('BlockhashNotFound')) {
      classification = 'ExpiredBlockhash';
    } else if (errStr.includes('InstructionError')) {
      classification = 'InstructionError';
    }

    summary.stages.push({
      stage: 'Failed',
      timestamp: now,
      slot,
      error: classification
    });
    summary.status = 'failed';
    summary.failureReason = classification;

    onUpdate({ ...summary });
    this.cleanup(signature);
  }

  private handleTimeout(signature: string) {
    const tracking = this.activeSubscriptions.get(signature);
    if (!tracking) return;

    const { summary, onUpdate } = tracking;
    const now = Date.now();

    // If it hasn't landed in 60s, it's highly likely to have expired due to blockhash or skipped leader slot
    const currentStages = summary.stages.map(s => s.stage);
    
    if (currentStages.includes('Processed') && !currentStages.includes('Confirmed')) {
      summary.stages.push({
        stage: 'Failed',
        timestamp: now,
        error: 'ConfirmationTimeout'
      });
      summary.status = 'failed';
      summary.failureReason = 'ConfirmationTimeout';
    } else {
      summary.stages.push({
        stage: 'Failed',
        timestamp: now,
        error: 'ExpiredBlockhash' // Timeout in landing is usually due to Blockhash expiration
      });
      summary.status = 'failed';
      summary.failureReason = 'ExpiredBlockhash';
    }

    console.log(`[Tracker] Transaction ${signature} timed out. Reason: ${summary.failureReason}`);
    onUpdate({ ...summary });
    this.cleanup(signature);
  }

  // Allow manual update/override (e.g. for simulations or mock data updates)
  public forceUpdateStage(signature: string, stage: 'Processed' | 'Confirmed' | 'Finalized' | 'Failed', slot?: number, error?: string) {
    const tracking = this.activeSubscriptions.get(signature);
    if (!tracking) return;

    const { summary, onUpdate } = tracking;
    const now = Date.now();
    const prevStage = summary.stages[summary.stages.length - 1];
    const latencyDelta = now - prevStage.timestamp;

    summary.stages.push({
      stage,
      timestamp: now,
      slot,
      latencyDelta,
      error
    });

    if (stage === 'Finalized') {
      summary.status = 'success';
      summary.finalizedAtSlot = slot;
      this.cleanup(signature);
    } else if (stage === 'Failed') {
      summary.status = 'failed';
      summary.failureReason = error || 'SimulationError';
      this.cleanup(signature);
    } else if (stage === 'Processed') {
      summary.processedAtSlot = slot;
    } else if (stage === 'Confirmed') {
      summary.confirmedAtSlot = slot;
    }

    onUpdate({ ...summary });
  }

  private cleanup(signature: string) {
    const tracking = this.activeSubscriptions.get(signature);
    if (!tracking) return;

    clearTimeout(tracking.timeoutTimer);
    setTimeout(() => {
      tracking.ws.terminate();
    }, 2000); // Small grace period before closing socket

    this.activeSubscriptions.delete(signature);
  }
}
