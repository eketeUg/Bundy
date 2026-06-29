# 📦 Bundy: Solana Jito Transaction Sandbox & Developer Tool

Bundy is an interactive developer tool and testing sandbox designed to observe the Solana network in real-time using high-performance Yellowstone gRPC streams, submit Jito bundles with dynamic tipping, track transaction commitment lifecycles, and leverage an OpenAI-powered AI Co-pilot to autonomously reason through and recover from transaction failures.

---

## 📋 Table of Contents
1. [Core Concepts](#-core-concepts)
2. [Bounty Questions & Answers](#-bounty-questions--answers)
3. [Features & Architecture](#-features--architecture)
4. [Installation & Setup](#-installation--logo-setup)
5. [Running the Application](#-running-the-application)
6. [Interactive Sandbox Guide](#-interactive-sandbox-guide)
7. [Bounty Infrastructure Providers](#-bounty-infrastructure-providers)

---

## 💡 Core Concepts

Solana transactions move through a complex lifecycle before landing on-chain. Understanding this flow is essential for building high-performance systems:
* **Yellowstone gRPC / Geyser Streams**: Instead of standard RPC polling, Geyser plugins stream slot and block updates at sub-millisecond latencies. By subscribing to Geyser, Bundy knows exactly when slots progress and which leader validator is active.
* **Jito Bundles**: Jito groups up to 5 transactions and submits them directly to block engines, bypassing the public mempool. This guarantees atomic, all-or-nothing execution, protecting transactions from frontrunning.
* **Dynamic Tipping**: To land a bundle, you send a tip (in SOL) to a Jito-designated tip account. Bundy queries Jito’s tip statistical endpoints to calculate tip sizes dynamically based on current network congestion.
* **AI-Assisted Retries**: Dumb retry loops waste fees and blockhash validity. Bundy embeds an OpenAI reasoning agent (`gpt-4o-mini`) that analyzes transaction failures (e.g., Expired Blockhash, Fee Too Low), explains *why* the failure happened, and recalculates parameters to resubmit autonomously.

---

## ❓ Bounty Questions & Answers

### Question 1: What does the delta between `processed_at` and `confirmed_at` tell you about network health at the time of submission?
* **Answer**: `processed_at` is the timestamp when the leader validator has locally executed your transaction and written it into a proposed block. `confirmed_at` is when a supermajority (66.6%+) of the Solana validator set has successfully voted on and confirmed that block.
* **Network Health Analysis**: The delta measures the **consensus convergence latency** and **shred propagation efficiency** of the network. 
  - **Healthy Network**: Under low congestion, this delta ranges from **1.2 to 2.0 seconds**, indicating that validators are voting quickly and shreds are propagating across the globe with minimal packet loss.
  - **Unhealthy Network**: If the delta spikes (e.g. 5+ seconds or timeouts), it indicates validator CPU saturation, fork voting disputes, or high network packet drop rates. This means the network is struggling to reach consensus on blocks.

### Question 2: Why should you never use finalized commitment when fetching a blockhash for a time-sensitive transaction?
* **Answer**: A blockhash on Solana is only valid for **150 slots** (approximately 60 seconds). 
  - When you request a blockhash at the `finalized` commitment level, you are receiving a blockhash from a block that has already been voted on by the network for at least **31+ slots** (taking about 12–15 seconds to reach finality).
  - Therefore, the blockhash is already ~15 seconds old when your code receives it, reducing its effective Time-To-Live (TTL) from 60 seconds to ~45 seconds.
  - If the network experiences any queueing delays, skipped slots, or Jito engine processing latency, your transaction will quickly fail with an `ExpiredBlockhash` error. For time-sensitive operations, always use `processed` or `confirmed` commitment levels to get the absolute freshest blockhash.

### Question 3: What happens to your bundle if the Jito leader skips their slot?
* **Answer**: Jito bundles are sent directly to Jito Block Engines, which construct blocks exclusively for Jito-enabled validator slots in the Solana leader schedule.
  - If the Jito validator scheduled for a slot **skips** it (due to hardware failure, voting delays, or network partitions), no block is produced for that slot.
  - As a result, the Jito Block Engine simply **drops and discards the bundle**. The transactions inside the bundle are never executed, they never land on-chain, and no tip is deducted from your account. 
  - To land, the bundle must be rebuilt with a fresh blockhash and resubmitted to the block engine for the next scheduled Jito leader.

---

## 🎨 Features & Architecture

Bundy is divided into clean backend and frontend layers:
* **The Backend (`src/`)**:
  * `stream.ts`: Stream client using the official `@triton-one/yellowstone-grpc` library to connect to secure gRPC streams, falling back to WebSockets if the gRPC connection is rate-limited.
  * `jito.ts`: Handles wallet keypairs, fetches tip floors, and structures Jito bundles.
  * `tracker.ts`: Listens to signature updates at multiple commitment levels using active WebSocket stream subscriptions.
  * `agent.ts`: AI Agent implementing the OpenAI chat completions API to autonomously evaluate failures and schedule retries.
  * `server.ts`: Coordinates API endpoints, runs the 10-bundle test suite, and manages persistent test keypair storage inside the `.env` file (so you don't lose your wallet address on restarts).
* **The Frontend (`src/App.tsx`)**: A glassmorphic dashboard displaying live Geyser slot telemetry, active transaction progress bars, the AI Agent's reasoning terminal, and local log history.

---

## ⚙️ Installation & Setup

1. **Navigate to the workspace**:
   ```bash
   cd /Users/ekete/.gemini/antigravity/scratch/solana-jito-stack
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment (`.env`)**:
   Rename `.env.example` to `.env` (already done automatically in this workspace) and add your keys:
   ```env
   # SolInfra gRPC Connection (Secure TLS prefix required)
   SOLINFRA_GRPC_URL=https://fra.grpc.solinfra.dev:443
   SOLINFRA_GRPC_TOKEN=IVqVc8D0q8Rj5RJw

   # OpenAI API Key (For AI Co-pilot reasoning)
   OPENAI_API_KEY=your-openai-api-key-here
   ```
   *Note: If `OPENAI_API_KEY` is left blank, Bundy automatically falls back to an interactive local rule-based reasoning simulator.*

---

## 🚀 Running the Application

Bundy utilizes a concurrent script to boot the backend and frontend simultaneously:
```bash
npm run dev
```
Once started, open your browser and navigate to:
👉 **`http://localhost:3000`**

---

## 🧪 Interactive Sandbox Guide

To test every aspect of the smart transaction stack:
1. **Fund Your Wallet**: Next to the **Funding Account** address in the header, click **Copy** to copy the full address. Paste it in a public devnet faucet, or click **Airdrop Devnet SOL** to request sandbox faucet funds (which fall back to simulation if the RPC faucet is rate-limited).
2. **Submit a Jito Bundle**: Select a Jito tip percentile (e.g. **P75**) and click **Send Jito Bundle**. You will see it step through `Submitted -> Processed -> Confirmed -> Finalized` on the visual timeline, plotting latency in milliseconds.
3. **Simulate a Fault & AI Recovery**: Click **Inject Expired Blockhash**. Bundy will intentionally fail the transaction. Watch the *AI Agent Reasoning Log* terminal—the OpenAI Co-pilot will write out its analysis, request a fresh blockhash, bump the Jito tip by `1.5x`, and autonomously resubmit it.
4. **Generate the Bounty Log**: Click **Run 10-Bundle Suite**. This will run 10 consecutive bundle submissions, injecting expired blockhashes on run #3 and low fees on run #7. All outputs are saved locally to `lifecycle.json` to satisfy your bounty requirements.

---

## 🛠️ Bounty Infrastructure Providers

* **RPC & Geyser gRPC**: Powered by **SolInfra** (with region-specific endpoint support and standard WebSocket failover).
* **AI Layer**: Powered by **OpenAI** (`gpt-4o-mini`).
* **Bundles**: Powered by **Jito Devnet Block Engine**.
