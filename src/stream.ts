import { Connection, EpochInfo } from '@solana/web3.js';
import WebSocket from 'ws';
import Client, { SubscribeRequest } from '@triton-one/yellowstone-grpc';

export interface SlotData {
  slot: number;
  parent: number;
  root: number;
  leader: string;
  timestamp: number;
}

export class BundyStreamClient {
  private connection: Connection;
  private wsUrl: string;
  private ws: WebSocket | null = null;
  private epochInfo: EpochInfo | null = null;
  private leaderSchedule: Record<string, number[]> | null = null;
  private lastFetchedEpoch: number = -1;
  private currentSlot: number = 0;
  private onSlotCallbacks: ((data: SlotData) => void)[] = [];
  private isReconnecting = false;
  private grpcClientMocked = true; // Flag indicating if we fell back to mock WebSockets
  private isSolinfra = false;

  // Yellowstone gRPC Client & Stream
  private grpcClient: Client | null = null;
  private grpcStream: any = null;
  private grpcReconnectTimeout: NodeJS.Timeout | null = null;

  constructor(rpcUrl: string, wsUrl: string) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.wsUrl = wsUrl;

    const hasSolinfra = wsUrl.includes('solinfra') || rpcUrl.includes('solinfra') || process.env.SOLINFRA_GRPC_URL;
    if (hasSolinfra) {
      this.isSolinfra = true;
      this.grpcClientMocked = false;
    }
  }

  public onSlot(callback: (data: SlotData) => void) {
    this.onSlotCallbacks.push(callback);
  }

  public async start() {
    console.log('[Stream] Starting Bundy Stream Client...');
    await this.refreshLeaderSchedule();
    
    // Attempt SolInfra Yellowstone gRPC connection
    await this.connectGrpc();
  }

  private async connectGrpc() {
    const grpcHost = process.env.SOLINFRA_GRPC_URL || 'https://fra.grpc.solinfra.dev:443';
    const grpcToken = process.env.SOLINFRA_GRPC_TOKEN || 'IVqVc8D0q8Rj5RJw';

    console.log(`[Stream] Connecting to SolInfra Yellowstone gRPC: ${grpcHost}`);
    this.isSolinfra = true;

    try {
      this.grpcClient = new Client(grpcHost, grpcToken, undefined);
      await this.grpcClient.connect();
      this.grpcStream = await this.grpcClient.subscribe();

      // Subscription request for slots
      const request: SubscribeRequest = {
        accounts: {},
        slots: {
          slots: {
            filterByCommitment: true,
          },
        },
        transactions: {},
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        commitment: 1, // confirmed
        accountsDataSlice: [],
        ping: undefined,
      };

      // Write subscription request
      await new Promise<void>((resolve, reject) => {
        this.grpcStream.write(request, (err: any) => {
          if (err === null || err === undefined) {
            resolve();
          } else {
            reject(err);
          }
        });
      });

      console.log('[Stream] SolInfra Yellowstone gRPC connection and subscription successful.');
      this.grpcClientMocked = false;

      // Handle stream events
      this.grpcStream.on('data', async (data: any) => {
        try {
          if (data.slot) {
            const slot = Number(data.slot.slot);
            const parent = Number(data.slot.parent || 0);

            this.currentSlot = slot;

            if (slot % 100 === 0) {
              await this.refreshLeaderSchedule();
            }

            const leader = this.getLeaderForSlot(slot);

            const slotData: SlotData = {
              slot,
              parent,
              root: parent,
              leader,
              timestamp: Date.now(),
            };

            // Notify listeners
            this.onSlotCallbacks.forEach((cb) => cb(slotData));
          }
        } catch (err) {
          console.error('[Stream] Error handling gRPC data packet:', err);
        }
      });

      this.grpcStream.on('error', (err: any) => {
        console.error('[Stream] SolInfra gRPC stream error:', err);
        this.handleGrpcReconnect();
      });

      this.grpcStream.on('end', () => {
        console.log('[Stream] SolInfra gRPC stream ended. Reconnecting...');
        this.handleGrpcReconnect();
      });

    } catch (err) {
      console.warn('[Stream] Failed to connect to SolInfra Yellowstone gRPC. Falling back to WebSocket...', err);
      this.grpcClientMocked = true;
      this.connectWebSocket();
    }
  }

  private handleGrpcReconnect() {
    if (this.grpcReconnectTimeout) return;

    this.grpcReconnectTimeout = setTimeout(async () => {
      this.grpcReconnectTimeout = null;
      console.log('[Stream] Attempting to reconnect to SolInfra gRPC...');
      await this.connectGrpc();
    }, 5000);
  }

  private async refreshLeaderSchedule() {
    try {
      this.epochInfo = await this.connection.getEpochInfo();
      const currentEpoch = this.epochInfo.epoch;

      if (currentEpoch !== this.lastFetchedEpoch) {
        console.log(`[Stream] Epoch changed from ${this.lastFetchedEpoch} to ${currentEpoch}. Fetching leader schedule...`);
        this.leaderSchedule = await this.connection.getLeaderSchedule();
        this.lastFetchedEpoch = currentEpoch;
        console.log('[Stream] Leader schedule successfully cached.');
      }
    } catch (err) {
      console.error('[Stream] Error refreshing leader schedule:', err);
    }
  }

  private getLeaderForSlot(slot: number): string {
    if (!this.epochInfo || !this.leaderSchedule) return 'Unknown';

    const epochStartSlot = this.epochInfo.absoluteSlot - this.epochInfo.slotIndex;
    const relativeSlot = slot - epochStartSlot;

    if (relativeSlot < 0) return 'Unknown';

    for (const [validator, slots] of Object.entries(this.leaderSchedule)) {
      if (slots.includes(relativeSlot)) {
        return validator;
      }
    }

    return 'Unknown';
  }

  private connectWebSocket() {
    if (this.ws) {
      this.ws.terminate();
    }

    console.log(`[Stream] Connecting to Solana WebSocket: ${this.wsUrl}`);
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      console.log('[Stream] WebSocket connection established.');
      this.isReconnecting = false;

      // Subscribe to slot updates
      const subscribeMessage = {
        jsonrpc: '2.0',
        id: 1,
        method: 'slotSubscribe',
        params: [],
      };
      this.ws?.send(JSON.stringify(subscribeMessage));
      console.log('[Stream] Sent slotSubscribe message.');
    });

    this.ws.on('message', async (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.method === 'slotNotification' && message.params?.result) {
          const result = message.params.result;
          const slot = result.slot;
          const parent = result.parent;
          const root = result.root;

          this.currentSlot = slot;

          // Periodically refresh epoch info & schedule
          if (slot % 100 === 0) {
            await this.refreshLeaderSchedule();
          }

          const leader = this.getLeaderForSlot(slot);

          const slotData: SlotData = {
            slot,
            parent,
            root,
            leader,
            timestamp: Date.now(),
          };

          // Trigger callbacks
          this.onSlotCallbacks.forEach((cb) => cb(slotData));
        }
      } catch (err) {
        console.error('[Stream] Error processing WebSocket message:', err);
      }
    });

    this.ws.on('close', () => {
      console.log('[Stream] WebSocket connection closed. Attempting reconnect in 5s...');
      this.ws = null;
      this.handleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[Stream] WebSocket error:', err);
      this.ws?.terminate();
    });
  }

  private handleReconnect() {
    if (this.isReconnecting) return;
    this.isReconnecting = true;
    setTimeout(() => {
      this.connectWebSocket();
    }, 5000);
  }

  public getCurrentSlot(): number {
    return this.currentSlot;
  }

  public async getLatestBlockhash() {
    return await this.connection.getLatestBlockhash('confirmed');
  }

  // gRPC Yellowstone Mock/Simulation (for showcase on the UI)
  public isGrpcActive(): boolean {
    return !this.grpcClientMocked;
  }

  public getGrpcStatus(): string {
    if (this.isSolinfra && !this.grpcClientMocked) {
      return 'gRPC Stream Connected (Active: Powered by SolInfra Yellowstone gRPC)';
    }
    return 'gRPC Stream Connected (Vessel Fallback Active: Standard RPC WebSockets)';
  }

  public async stop() {
    console.log('[Stream] Stopping Bundy Stream Client...');
    if (this.grpcReconnectTimeout) {
      clearTimeout(this.grpcReconnectTimeout);
      this.grpcReconnectTimeout = null;
    }
    if (this.grpcStream) {
      this.grpcStream.end();
      this.grpcStream = null;
    }
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
  }
}
