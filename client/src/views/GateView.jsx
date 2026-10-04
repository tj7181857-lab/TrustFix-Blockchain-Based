import React, { useState } from "react";
import { API_BASE } from "../contractConfig";
import { useContract } from "../hooks/useContract";

export default function GateView({ wallet }) {
  const contract = useContract(wallet.signer);
  const [tokenId, setTokenId] = useState("");
  const [ownerCheck, setOwnerCheck] = useState("");
  const [ticket, setTicket] = useState(null);
  const [loading, setLoading] = useState(false);
  const [using, setUsing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const verify = async (event) => {
    event.preventDefault();
    setTicket(null);
    setError("");
    setMessage("");
    if (!/^\d+$/.test(tokenId)) {
      setError("Enter a valid numeric ticket ID.");
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/ticket/${tokenId}`);
      const data = await response.json();
      if (!response.ok) {
        setTicket({ verdict: "INVALID", reason: data.error || "Ticket does not exist." });
        return;
      }
      const expectedOwner = data.owner || data.previousOwner;
      if (ownerCheck.trim() && ownerCheck.trim().toLowerCase() !== expectedOwner?.toLowerCase()) {
        setTicket({ ...data, verdict: "INVALID", reason: "The supplied wallet does not match the current ticket owner." });
      } else if (data.status === "USED") {
        setTicket({ ...data, verdict: "ALREADY USED" });
      } else if (data.status === "FROZEN") {
        setTicket({ ...data, verdict: "FROZEN" });
      } else if (data.status === "REVOKED") {
        setTicket({ ...data, verdict: "REVOKED", reason: "This ticket was revoked and refunded on-chain." });
      } else if (data.status === "SOLD") {
        setTicket({ ...data, verdict: "VALID" });
      } else {
        setTicket({ ...data, verdict: "INVALID", reason: "This ticket has not been purchased." });
      }
    } catch (cause) {
      setError(cause.message || "Unable to read the ticket from the blockchain service.");
    } finally {
      setLoading(false);
    }
  };

  const useTicket = async () => {
    if (!contract || !ticket || ticket.verdict !== "VALID") return;
    if (!wallet.isOrganizer && !wallet.isStaff) {
      setError("The connected wallet is not authorized gate staff.");
      return;
    }
    if (!wallet.isCorrectNetwork) {
      setError("Switch MetaMask to Hardhat Local (chain 31337).");
      return;
    }
    setUsing(true);
    setError("");
    setMessage("Confirm ticket use in MetaMask.");
    try {
      const tx = await contract.markUsed(ticket.tokenId);
      setMessage(`Transaction pending: ${tx.hash}`);
      await tx.wait();
      const response = await fetch(`${API_BASE}/api/ticket/${ticket.tokenId}`);
      if (!response.ok) throw new Error("Ticket was used on-chain, but a fresh status read failed.");
      const refreshed = await response.json();
      setTicket({ ...refreshed, verdict: refreshed.status === "USED" ? "ALREADY USED" : refreshed.status });
      setMessage(`Ticket use confirmed on-chain. Transaction: ${tx.hash}`);
    } catch (cause) {
      setError(cause?.shortMessage || cause?.reason || cause?.message || "Could not use this ticket.");
      setMessage("");
    } finally {
      setUsing(false);
    }
  };

  const verdictClass = ticket?.verdict === "VALID" ? "verdict-valid"
    : ticket?.verdict === "ALREADY USED" ? "verdict-used"
      : ticket ? "verdict-invalid" : "";

  return (
    <section className="page-section narrow-section">
      <div className="page-heading"><div><span className="eyebrow">ON-CHAIN STATUS CHECK</span><h1>Verify a ticket</h1><p className="muted">Ticket state is read from the multi-event contract. Authorized gate operators can consume a valid ticket on-chain.</p></div></div>
      <form className="form-card" onSubmit={verify}>
        <label className="form-label">Ticket ID<input required inputMode="numeric" className="form-input" value={tokenId} onChange={(e) => setTokenId(e.target.value)} placeholder="e.g. 12" /></label>
        <label className="form-label">Expected owner address <span className="muted">(optional)</span><input className="form-input mono" value={ownerCheck} onChange={(e) => setOwnerCheck(e.target.value)} placeholder="0x…" /></label>
        <button className="button button-primary" disabled={loading}>{loading ? "Checking chain…" : "Verify ticket"}</button>
      </form>

      {error && <div className="error-panel" role="alert">{error}</div>}
      {message && <div className="notice" role="status">{message}</div>}
      {ticket && <section className={`verdict-card ${verdictClass}`} aria-live="polite">
        <span className="eyebrow">TICKET STATUS · EVENT #{ticket.eventId ?? "—"}</span>
        <h2>{ticket.verdict}</h2>
        {ticket.reason && <p>{ticket.reason}</p>}
        <dl className="ticket-facts"><div><dt>Ticket ID</dt><dd>#{ticket.tokenId}</dd></div><div><dt>Seat</dt><dd>{ticket.seatNumber ?? "—"}</dd></div><div><dt>Current owner</dt><dd className="mono">{ticket.owner ? `${ticket.owner.slice(0, 8)}…${ticket.owner.slice(-6)}` : "No current owner"}</dd></div><div><dt>Contract state</dt><dd>{ticket.status || ticket.verdict}</dd></div></dl>
        {ticket.verdict === "VALID" && <div className="gate-action">
          {!wallet.account ? <p className="notice notice-warning">Connect the authorized organizer or gate-operator wallet.</p>
            : !wallet.isOrganizer && !wallet.isStaff ? <p className="notice notice-warning">Connected role: {wallet.role}. Gate operator authorization is required to use tickets.</p>
              : <button className="button button-primary" disabled={using || !wallet.isCorrectNetwork} onClick={useTicket}>{using ? "Waiting for confirmation…" : "Admit and mark used on-chain"}</button>}
        </div>}
      </section>}
    </section>
  );
}
