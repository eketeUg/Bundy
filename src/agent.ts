import OpenAI from 'openai';
import { TipEstimates } from './jito';

export interface AgentDecision {
  reasoning: string;
  shouldRetry: boolean;
  action: 'REFRESH_BLOCKHASH' | 'INCREASE_TIP' | 'ABANDON' | 'NONE';
  newTipAmountLamports?: number;
  remarks: string;
}

export class BundyAIAgent {
  private openai: OpenAI | null = null;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      try {
        this.openai = new OpenAI({ apiKey });
        console.log('[AI Agent] OpenAI client initialized successfully.');
      } catch (err) {
        console.error('[AI Agent] Failed to initialize OpenAI client:', err);
      }
    } else {
      console.log('[AI Agent] No OPENAI_API_KEY found. Falling back to local reasoning engine.');
    }
  }

  /**
   * Evaluates a transaction failure and decides on a retry strategy.
   */
  public async analyzeFailure(
    failureReason: string,
    currentTipLamports: number,
    tipEstimates: TipEstimates,
    retryCount: number
  ): Promise<AgentDecision> {
    console.log(`[AI Agent] Analyzing failure: ${failureReason} (Current tip: ${currentTipLamports} lamports, Retry: ${retryCount})`);

    if (retryCount >= 3) {
      return {
        reasoning: 'The transaction has failed 3 times. Continuing to retry would waste resources and SOL fees without further diagnostics.',
        shouldRetry: false,
        action: 'ABANDON',
        remarks: 'Max retries exceeded. Manual intervention required.'
      };
    }

    if (this.openai) {
      try {
        const prompt = `
          You are Bundy AI, an autonomous Solana transaction reliability co-pilot.
          A transaction bundle submitted to the Jito block engine failed.
          
          Failure Reason: "${failureReason}"
          Current Jito Tip: ${currentTipLamports} lamports
          Current Jito Network Tip Estimates:
            - 50th percentile (p50): ${tipEstimates.p50} lamports
            - 75th percentile (p75): ${tipEstimates.p75} lamports
            - 90th percentile (p90): ${tipEstimates.p90} lamports
            - 95th percentile (p95): ${tipEstimates.p95} lamports
            - 99th percentile (p99): ${tipEstimates.p99} lamports
          
          Previous retry attempts: ${retryCount}
          
          Analyze the failure and decide on the next action:
          1. If the failure is "ExpiredBlockhash", you must decide to REFRESH_BLOCKHASH and recalculate the tip.
          2. If the failure is "FeeTooLow" or network congestion is high, decide to INCREASE_TIP.
          3. If the error is fatal or retries are failing, decide to ABANDON.
          
          Provide your decision in structured JSON format with the following fields:
          {
            "reasoning": "Your step-by-step reasoning explaining why the failure happened and how your decision solves it",
            "shouldRetry": true/false,
            "action": "REFRESH_BLOCKHASH" | "INCREASE_TIP" | "ABANDON",
            "newTipAmountLamports": number (suggested new tip in lamports, based on the network estimates),
            "remarks": "Short summary of the action"
          }
        `;

        const response = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' }
        });

        const text = response.choices[0].message.content || '';
        const decision: AgentDecision = JSON.parse(text);
        console.log('[AI Agent] OpenAI Decision:', decision);
        return decision;
      } catch (err) {
        console.error('[AI Agent] Error in OpenAI request, falling back to local reasoning:', err);
      }
    }

    // Fallback: local reasoning engine simulating detailed LLM thought process
    return this.getLocalReasoning(failureReason, currentTipLamports, tipEstimates, retryCount);
  }

  private getLocalReasoning(
    failureReason: string,
    currentTipLamports: number,
    tipEstimates: TipEstimates,
    retryCount: number
  ): AgentDecision {
    const defaultP90 = tipEstimates.p90;
    
    if (failureReason === 'ExpiredBlockhash') {
      const suggestedTip = Math.max(currentTipLamports, defaultP90);
      return {
        reasoning: `**DETECTION**: Transaction failed due to an expired blockhash (Error: ExpiredBlockhash).
**ANALYSIS**: This occurs when a transaction is not included in a block within 150 slots (~60 seconds) of the blockhash being generated. This was likely caused by a skipped slot from the Jito leader or the bundle failing to land in the designated leader window.
**RESOLUTION**: We must fetch a fresh blockhash from the Solana RPC. Since the network might be experiencing slight delays, we will also ensure the tip is aligned with the 90th percentile (${suggestedTip} lamports) to guarantee high processing priority.`,
        shouldRetry: true,
        action: 'REFRESH_BLOCKHASH',
        newTipAmountLamports: suggestedTip,
        remarks: 'Refreshed blockhash and reset transaction lifetime.'
      };
    }

    if (failureReason === 'FeeTooLow') {
      const bumpedTip = Math.floor(currentTipLamports * 1.5);
      const suggestedTip = Math.max(bumpedTip, tipEstimates.p95);
      return {
        reasoning: `**DETECTION**: Jito Block Engine rejected the bundle due to fee parameters (Error: FeeTooLow).
**ANALYSIS**: The validator tip of ${currentTipLamports} lamports fell below the competitive floor for current network blocks. High congestion is driving tip averages up.
**RESOLUTION**: We will increase the Jito bundle tip to ${suggestedTip} lamports (targeting the 95th percentile) to ensure validators prioritize our bundle over others in the mempool.`,
        shouldRetry: true,
        action: 'INCREASE_TIP',
        newTipAmountLamports: suggestedTip,
        remarks: `Bumped bundle tip to ${suggestedTip} lamports.`
      };
    }

    // Default catch-all
    const suggestedTip = Math.max(currentTipLamports, tipEstimates.p75);
    return {
      reasoning: `**DETECTION**: General bundle execution failure (Error: ${failureReason}).
**ANALYSIS**: The transaction did not successfully land. To resolve, we will perform a complete state refresh.
**RESOLUTION**: We will fetch a fresh blockhash and set a competitive tip of ${suggestedTip} lamports (75th percentile) to attempt resubmission in the next slot window.`,
      shouldRetry: true,
      action: 'REFRESH_BLOCKHASH',
      newTipAmountLamports: suggestedTip,
      remarks: 'Re-routing transaction with default parameter bumps.'
    };
  }
}
