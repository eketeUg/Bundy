import React, { useState, useEffect, useRef } from 'react';
import { 
  Activity, 
  Cpu, 
  Layers, 
  Terminal, 
  Send, 
  Zap, 
  RefreshCw, 
  AlertTriangle, 
  CheckCircle2, 
  Wallet, 
  Play, 
  Flame, 
  Clock 
} from 'lucide-react';

interface SlotData {
  slot: number;
  parent: number;
  root: number;
  leader: string;
  timestamp: number;
}

interface LifecycleStage {
  stage: 'Submitted' | 'Processed' | 'Confirmed' | 'Finalized' | 'Failed';
  timestamp: string;
  slot?: number;
  latencyDeltaMs?: number;
  error?: string;
}

interface TransactionSummary {
  signature: string;
  bundleId: string;
  submittedAt: string;
  tipAmountLamports: number;
  stages: LifecycleStage[];
  status: 'pending' | 'success' | 'failed';
  failureReason?: string;
  processedAtSlot?: number;
  confirmedAtSlot?: number;
  finalizedAtSlot?: number;
}

interface SystemStatus {
  publicKey: string;
  balance: number;
  rpcUrl: string;
  jitoEngine: string;
  isGrpcActive: boolean;
  grpcStatus: string;
}

interface AgentLog {
  message: string;
  timestamp: number;
}

export default function App() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [currentSlot, setCurrentSlot] = useState<SlotData | null>(null);
  const [activeTx, setActiveTx] = useState<TransactionSummary | null>(null);
  const [logs, setLogs] = useState<TransactionSummary[]>([]);
  const [agentLogs, setAgentLogs] = useState<AgentLog[]>([]);
  
  const [tipPercentile, setTipPercentile] = useState<string>('p75');
  const [airdropLoading, setAirdropLoading] = useState(false);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [suiteLoading, setSuiteLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const terminalEndRef = useRef<HTMLDivElement>(null);

  const handleCopy = () => {
    if (status?.publicKey) {
      navigator.clipboard.writeText(status.publicKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const API_URL = '';
  const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

  useEffect(() => {
    // Initial fetch of logs and status
    fetchStatus();
    fetchLogs();

    // WebSocket connection
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('Dashboard connected to backend WebSocket.');
    };

    ws.onmessage = (event) => {
      const { type, data } = JSON.parse(event.data);

      if (type === 'SLOT_UPDATE') {
        setCurrentSlot(data);
      } else if (type === 'TX_UPDATE') {
        setActiveTx(data);
        if (data.status === 'success' || data.status === 'failed') {
          // Re-fetch logs to show completed transaction in table
          setTimeout(fetchLogs, 1000);
        }
      } else if (type === 'AGENT_LOG') {
        setAgentLogs((prev) => [...prev, data]);
      } else if (type === 'SYSTEM_STATUS') {
        setStatus(data);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected. Retrying connection in 5s...');
    };

    return () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    // Scroll AI Terminal to bottom on new log
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [agentLogs]);

  const fetchStatus = async () => {
    try {
      const res = await fetch(`${API_URL}/api/status`);
      const data = await res.json();
      setStatus(data);
    } catch (e) {
      console.error('Error fetching system status:', e);
    }
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch(`${API_URL}/api/logs`);
      const data = await res.json();
      setLogs(data);
    } catch (e) {
      console.error('Error fetching logs:', e);
    }
  };

  const handleAirdrop = async () => {
    setAirdropLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/airdrop`, { method: 'POST' });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Server error ${res.status}: ${errText}`);
      }
      const data = await res.json();
      if (data.success) {
        setStatus((prev) => prev ? { ...prev, balance: data.balance } : null);
        addAgentLog('System', `Devnet balance updated. New balance: ${data.balance} SOL (Sandbox Faucet Active)`);
      }
    } catch (e: any) {
      addAgentLog('System Error', `Airdrop failed: ${e.message}`);
    } finally {
      setAirdropLoading(false);
    }
  };

  const handleSubmitBundle = async (isFaulty = false) => {
    setSubmitLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/submit-bundle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tipPercentile, isFaultyBlockhash: isFaulty })
      });
      const data = await res.json();
      if (data.success) {
        addAgentLog('System', `Bundle submitted. Signature: ${data.signature.substring(0, 8)}...`);
      }
    } catch (e: any) {
      addAgentLog('System Error', `Bundle submission failed: ${e.message}`);
    } finally {
      setSubmitLoading(false);
    }
  };

  const handleRunSuite = async () => {
    setSuiteLoading(true);
    try {
      await fetch(`${API_URL}/api/run-suite`, { method: 'POST' });
    } catch (e: any) {
      addAgentLog('System Error', `Failed to start suite: ${e.message}`);
    } finally {
      // Suite runs asynchronously, toggle state after small delay
      setTimeout(() => setSuiteLoading(false), 2000);
    }
  };

  const addAgentLog = (sender: string, message: string) => {
    setAgentLogs((prev) => [...prev, { message: `[${sender}] ${message}`, timestamp: Date.now() }]);
  };

  const formatLamports = (lamports: number) => {
    return (lamports / 1000000000).toFixed(6) + ' SOL';
  };

  // Helper to check commitment status for timeline steps
  const getTimelineStepStatus = (stepName: string) => {
    if (!activeTx) return 'inactive';
    const stages = activeTx.stages.map((s) => s.stage);

    if (stages.includes(stepName as any)) {
      return 'completed';
    }
    
    // Special fail classification
    if (activeTx.status === 'failed') {
      const lastStage = stages[stages.length - 1];
      if (stepName === 'Finalized' && lastStage === 'Failed') {
        return 'failed';
      }
    }

    // Active pointer
    if (stepName === 'Processed' && stages.includes('Submitted') && !stages.includes('Processed') && activeTx.status === 'pending') {
      return 'active';
    }
    if (stepName === 'Confirmed' && stages.includes('Processed') && !stages.includes('Confirmed') && activeTx.status === 'pending') {
      return 'active';
    }
    if (stepName === 'Finalized' && stages.includes('Confirmed') && !stages.includes('Finalized') && activeTx.status === 'pending') {
      return 'active';
    }

    return 'inactive';
  };

  const getLatencyForStep = (stepName: string) => {
    if (!activeTx) return null;
    const stageObj = activeTx.stages.find((s) => s.stage === stepName);
    if (stageObj && stageObj.latencyDeltaMs) {
      return `+${stageObj.latencyDeltaMs}ms`;
    }
    return null;
  };

  return (
    <div className="dashboard-container">
      {/* Header */}
      <header>
        <div className="logo-section">
          <h1>📦 Bundy Sandbox</h1>
          <p>Solana Jito Transaction Sandbox & Developer Tool</p>
        </div>
        <div className="system-stats">
          <div className="stat-item">
            <label>Funding Account</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.8rem', fontFamily: 'monospace', color: 'var(--color-secondary)' }}>
                {status ? `${status.publicKey.substring(0, 6)}...${status.publicKey.substring(status.publicKey.length - 6)}` : 'Loading...'}
              </span>
              {status && (
                <button 
                  onClick={handleCopy}
                  title="Copy full address"
                  style={{
                    background: 'rgba(6, 182, 212, 0.1)',
                    border: '1px solid rgba(6, 182, 212, 0.2)',
                    color: copied ? 'var(--color-success)' : 'var(--color-secondary)',
                    cursor: 'pointer',
                    fontSize: '0.65rem',
                    padding: '0.1rem 0.4rem',
                    borderRadius: '4px',
                    fontFamily: 'var(--font-body)',
                    fontWeight: 600,
                    transition: 'all 0.2s'
                  }}
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              )}
            </div>
          </div>
          <div className="stat-item">
            <label>Balance</label>
            <span>
              <Wallet size={16} className="text-secondary" />
              {status ? `${status.balance.toFixed(4)} SOL` : '0.00 SOL'}
            </span>
          </div>
          <div className="stat-item">
            <label>Solana Network</label>
            <span style={{ color: 'var(--color-success)' }}>
              <Activity size={16} /> Devnet
            </span>
          </div>
        </div>
      </header>

      {/* Main Grid */}
      <div className="main-grid">
        {/* Left Side: Live Stream & Sandbox Controls */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          
          {/* Live Network Stream */}
          <div className="panel">
            <h2><Activity size={20} className="text-secondary" /> Live Geyser / gRPC Slot Stream</h2>
            <div className="slot-badge-grid">
              <div className="slot-badge">
                <span className="label" style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem', textTransform: 'uppercase' }}>Current Slot</span>
                <span className="value">{currentSlot ? currentSlot.slot : 'Syncing...'}</span>
              </div>
              <div className="slot-badge">
                <span className="label" style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem', textTransform: 'uppercase' }}>Slot Leader</span>
                <span className="value" style={{ fontSize: '0.85rem', fontFamily: 'monospace', color: 'var(--color-primary)' }}>
                  {currentSlot ? `${currentSlot.leader.substring(0, 8)}...${currentSlot.leader.substring(currentSlot.leader.length - 8)}` : 'Awaiting slot...'}
                </span>
              </div>
            </div>
            <div style={{ 
              fontSize: '0.85rem', 
              display: 'flex', 
              alignItems: 'center', 
              gap: '0.5rem', 
              background: status?.isGrpcActive ? 'rgba(16, 185, 129, 0.08)' : 'rgba(139, 92, 246, 0.08)', 
              padding: '0.6rem 0.8rem', 
              borderRadius: '10px', 
              border: status?.isGrpcActive ? '1px solid rgba(16, 185, 129, 0.2)' : '1px solid rgba(139, 92, 246, 0.2)' 
            }}>
              <span style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: status?.isGrpcActive ? 'var(--color-success)' : 'var(--color-primary)',
                boxShadow: status?.isGrpcActive ? '0 0 8px var(--color-success)' : '0 0 8px var(--color-primary)',
                display: 'inline-block'
              }}></span>
              <span style={{ 
                color: status?.isGrpcActive ? 'var(--color-success)' : 'var(--color-text-muted)', 
                fontFamily: 'var(--font-mono)', 
                fontSize: '0.75rem',
                fontWeight: 600
              }}>
                {status ? status.grpcStatus : 'Initializing connection...'}
              </span>
            </div>
          </div>

          {/* Sandbox Controls */}
          <div className="panel">
            <h2><Cpu size={20} className="text-primary" /> Interactive Bundle Sandbox</h2>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <label style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>Jito Tip Agility (Percentile Target)</label>
              <div className="btn-group">
                {['p50', 'p75', 'p90', 'p95', 'p99'].map((pct) => (
                  <button 
                    key={pct}
                    className={`btn ${tipPercentile === pct ? '' : 'btn-secondary'}`}
                    onClick={() => setTipPercentile(pct)}
                    style={{ flex: 1, padding: '0.5rem' }}
                  >
                    {pct.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            <div className="btn-group">
              <button 
                className="btn btn-secondary" 
                onClick={handleAirdrop} 
                disabled={airdropLoading}
                style={{ flex: 1 }}
              >
                {airdropLoading ? <RefreshCw size={16} className="animate-spin" /> : <Wallet size={16} />}
                Airdrop Devnet SOL
              </button>
              
              <button 
                className="btn" 
                onClick={() => handleSubmitBundle(false)} 
                disabled={submitLoading || suiteLoading}
                style={{ flex: 1 }}
              >
                <Send size={16} />
                Send Jito Bundle
              </button>
            </div>

            <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '1rem' }}>
              <label style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', display: 'block', marginBottom: '0.75rem' }}>
                Bounty Fault Injector & Suite Playground
              </label>
              <div className="btn-group">
                <button 
                  className="btn btn-danger" 
                  onClick={() => handleSubmitBundle(true)}
                  disabled={submitLoading || suiteLoading}
                  style={{ flex: 1 }}
                >
                  <Flame size={16} />
                  Inject Expired Blockhash
                </button>
                
                <button 
                  className="btn btn-secondary"
                  onClick={handleRunSuite}
                  disabled={suiteLoading}
                  style={{ flex: 1, border: '1px solid var(--color-primary)' }}
                >
                  <Play size={16} className="text-primary" />
                  Run 10-Bundle Suite
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right Side: AI Agent Reasoning Terminal & Timeline */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          
          {/* AI Decision Agent Terminal */}
          <div className="panel">
            <h2><Terminal size={20} className="text-success" /> AI Agent Reasoning Log</h2>
            <div className="terminal">
              {agentLogs.length === 0 && (
                <div className="terminal-line terminal-system">
                  System: Awaiting transactions... Click "Send Jito Bundle" or "Inject Expired Blockhash" to trigger AI Agent reasoning.
                </div>
              )}
              {agentLogs.map((log, idx) => {
                let className = 'terminal-system';
                if (log.message.includes('[AI Agent]')) {
                  className = 'terminal-agent';
                } else if (log.message.includes('succeeded') || log.message.includes('success')) {
                  className = 'terminal-success';
                }
                
                return (
                  <div key={idx} className={`terminal-line ${className}`}>
                    {log.message}
                  </div>
                );
              })}
              <div ref={terminalEndRef} />
            </div>
          </div>

          {/* Active Transaction Lifecycle */}
          <div className="panel">
            <h2><Layers size={20} className="text-secondary" /> Transaction Lifecycle Tracker</h2>
            {activeTx ? (
              <div className="tx-card">
                <div className="tx-header">
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>Signature</span>
                    <span className="tx-sig">{activeTx.signature.substring(0, 16)}...</span>
                  </div>
                  <span className={`tx-status-badge ${activeTx.status}`}>
                    {activeTx.status}
                  </span>
                </div>

                <div className="tx-header" style={{ borderTop: '1px solid rgba(255,255,255,0.03)', paddingTop: '0.5rem' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>Jito Tip Amount</span>
                  <span className="tx-tip">{formatLamports(activeTx.tipAmountLamports)}</span>
                </div>

                {/* Progress bar timeline */}
                <div className="timeline">
                  {['Submitted', 'Processed', 'Confirmed', 'Finalized'].map((step) => {
                    const stepStatus = getTimelineStepStatus(step);
                    const latency = getLatencyForStep(step);

                    return (
                      <div key={step} className={`timeline-step ${stepStatus}`}>
                        <div className="step-dot">
                          {stepStatus === 'completed' && <CheckCircle2 size={12} />}
                          {stepStatus === 'failed' && <AlertTriangle size={12} />}
                          {stepStatus === 'active' && <Clock size={12} className="animate-spin" />}
                          {stepStatus === 'inactive' && '•'}
                        </div>
                        <span className="step-label">{step}</span>
                        {latency && <span className="step-latency">{latency}</span>}
                      </div>
                    );
                  })}
                </div>
                {activeTx.failureReason && (
                  <div style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.2)', padding: '0.75rem', borderRadius: '8px', fontSize: '0.8rem', color: 'var(--color-danger)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <AlertTriangle size={16} />
                    <span>Error Code: {activeTx.failureReason}</span>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: '0.85rem' }}>
                No active transaction. Submit a bundle to trace lifecycle.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Historical Logs List */}
      <div className="panel" style={{ marginTop: '0.5rem' }}>
        <h2><Layers size={20} className="text-primary" /> Geyser Lifecycle Log (lifecycle.json)</h2>
        <div style={{ overflowX: 'auto' }}>
          <table className="logs-table">
            <thead>
              <tr>
                <th>Signature</th>
                <th>Time Submitted</th>
                <th>Tip Amount</th>
                <th>Processed (Slot)</th>
                <th>Confirmed (Slot)</th>
                <th>Finalized (Slot)</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: '2rem' }}>
                    No bundle submissions logged in lifecycle.json yet.
                  </td>
                </tr>
              ) : (
                logs.map((log, idx) => (
                  <tr key={idx}>
                    <td className="tx-sig">{log.signature.substring(0, 12)}...</td>
                    <td>{new Date(log.submittedAt).toLocaleTimeString()}</td>
                    <td><span className="tx-tip" style={{ fontSize: '0.75rem' }}>{formatLamports(log.tipAmountLamports)}</span></td>
                    <td>{log.processedAtSlot ? `Slot ${log.processedAtSlot}` : '-'}</td>
                    <td>{log.confirmedAtSlot ? `Slot ${log.confirmedAtSlot}` : '-'}</td>
                    <td>{log.finalizedAtSlot ? `Slot ${log.finalizedAtSlot}` : '-'}</td>
                    <td>
                      <span className={`tx-status-badge ${log.status}`} style={{ fontSize: '0.7rem' }}>
                        {log.status}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
