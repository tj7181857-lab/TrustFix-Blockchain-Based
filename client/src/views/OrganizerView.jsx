import React, { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { API_BASE } from "../contractConfig";
import { useContract } from "../hooks/useContract";

function Metric({ label, value, hint }) {
  return <article className="metric-card"><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</article>;
}

function EventActionButton({ event, contract, refresh }) {
  const [state, setState] = useState("");
  const toggle = async () => {
    setState("Confirm in MetaMask…");
    try {
      await (await contract.setEventActive(event.eventId, !event.active)).wait();
      setState(`Event ${event.active ? "deactivated" : "activated"}.`);
      await refresh();
    } catch (error) {
      setState(error?.shortMessage || error?.reason || error?.message || "Transaction failed.");
    }
  };
  return <div className="table-action"><button className="button button-secondary button-small" onClick={toggle}>{event.active ? "Deactivate" : "Activate"}</button>{state && <span>{state}</span>}</div>;
}

export default function OrganizerView({ mode, wallet, socketData }) {
  const contract = useContract(wallet.signer);
  const [analytics, setAnalytics] = useState(null);
  const [events, setEvents] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [ticketPurchases, setTicketPurchases] = useState([]);
  const [riskData, setRiskData] = useState({ allScores: [], clusters: [], graph: { nodes: [], edges: [] } });
  const [riskSummary, setRiskSummary] = useState({ trackedWallets: 0, lowRisk: 0, mediumRisk: 0, highRisk: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    name: "", venue: "", date: "", time: "", priceEth: "", totalTickets: "", maxTicketsPerWallet: "",
  });
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState(null);
  const [actionStatus, setActionStatus] = useState({});

  const refresh = useCallback(async () => {
    let response;
    try {
      response = await fetch(`${API_BASE}/api/analytics`);
    } catch {
      throw new Error("Backend unavailable.");
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.status === "contract-unavailable"
        ? "Unable to connect to the TrustTix contract."
        : "Backend unavailable.");
    }
    const data = await response.json();
    setError("");
    setAnalytics(data);
    setEvents(data.events);
    setPurchases(data.purchases);
    setTicketPurchases(data.ticketPurchases);
    setRiskData({
      allScores: data.walletSignals,
      clusters: data.clusters,
      graph: { nodes: [], edges: [] },
    });
    setRiskSummary(data.riskSummary);
  }, []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    refresh().catch((cause) => { if (live) setError(cause.message); })
      .finally(() => { if (live) setLoading(false); });
    const interval = setInterval(() => {
      refresh().catch((cause) => setError(cause.message));
    }, 8000);
    return () => { live = false; clearInterval(interval); };
  }, [refresh]);

  useEffect(() => {
    if (!socketData?.latestPurchase) return;
    refresh().catch((cause) => setError(cause.message));
  }, [socketData?.latestPurchase, refresh]);

  const totals = analytics?.totals;
  const uniqueWallets = totals?.uniqueBuyerWallets ?? 0;
  const createEvent = async (event) => {
    event.preventDefault();
    if (!contract || !wallet.isCorrectNetwork) return;
    setCreating(true);
    setCreateMessage({ type: "pending", text: "Confirm event creation in MetaMask." });
    try {
      const priceWei = ethers.parseEther(form.priceEth);
      const supply = BigInt(form.totalTickets);
      const maxPerWallet = BigInt(form.maxTicketsPerWallet);
      const transaction = await contract.createEvent(
        form.name.trim(),
        form.venue.trim(),
        form.date,
        form.time,
        priceWei,
        supply,
        maxPerWallet
      );
      setCreateMessage({ type: "pending", text: `Event transaction submitted: ${transaction.hash}` });
      await transaction.wait();
      setCreateMessage({ type: "success", text: `Event created on-chain. Transaction: ${transaction.hash}` });
      setForm({ name: "", venue: "", date: "", time: "", priceEth: "", totalTickets: "", maxTicketsPerWallet: "" });
      await refresh();
    } catch (cause) {
      setCreateMessage({ type: "error", text: cause?.shortMessage || cause?.reason || cause?.message || "Event creation failed." });
    } finally {
      setCreating(false);
    }
  };

  const manageTicket = async (purchase, action) => {
    if (!contract || !wallet.isOrganizer || !wallet.isCorrectNetwork) return;
    setActionStatus((current) => ({ ...current, [purchase.tokenId]: "Confirm in MetaMask…" }));
    try {
      const tx = await contract[action](purchase.tokenId);
      setActionStatus((current) => ({ ...current, [purchase.tokenId]: `Pending ${tx.hash.slice(0, 12)}…` }));
      await tx.wait();
      setActionStatus((current) => ({ ...current, [purchase.tokenId]: "Confirmed on-chain" }));
      await refresh();
    } catch (cause) {
      setActionStatus((current) => ({
        ...current,
        [purchase.tokenId]: cause?.shortMessage || cause?.reason || cause?.message || "Transaction failed.",
      }));
    }
  };

  if (loading) return <div className="empty-state">Loading indexed on-chain organizer data…</div>;
  if (error) return <div className="error-panel">{error}</div>;
  if (!analytics) return <div className="error-panel">Backend unavailable.</div>;

  if (mode === "create") {
    return <section className="page-section narrow-section">
      <div className="page-heading"><div><span className="eyebrow">ON-CHAIN EVENT MANAGEMENT</span><h1>Create event</h1><p className="muted">Event details and ticket inventory are written to the TrustTix contract.</p></div></div>
      {!wallet.isOrganizer && <div className="notice notice-warning">Connect the contract organizer wallet to create events.</div>}
      {!wallet.isCorrectNetwork && <div className="notice notice-warning">Switch MetaMask to Hardhat Local (chain 31337).</div>}
      <form className="form-card" onSubmit={createEvent}>
        <label className="form-label">Event name<input required maxLength="100" className="form-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="form-label">Venue<input required maxLength="120" className="form-input" value={form.venue} onChange={(e) => setForm({ ...form, venue: e.target.value })} /></label>
        <div className="form-row"><label className="form-label">Date<input required type="date" className="form-input" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label><label className="form-label">Time<input required type="time" className="form-input" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} /></label></div>
        <div className="form-row"><label className="form-label">Ticket price (ETH)<input required type="number" min="0.000000000000000001" step="any" className="form-input" value={form.priceEth} onChange={(e) => setForm({ ...form, priceEth: e.target.value })} /></label><label className="form-label">Total tickets<input required type="number" min="1" step="1" className="form-input" value={form.totalTickets} onChange={(e) => setForm({ ...form, totalTickets: e.target.value })} /></label></div>
        <label className="form-label">Maximum tickets per wallet<input required type="number" min="1" max={form.totalTickets || undefined} step="1" className="form-input" value={form.maxTicketsPerWallet} onChange={(e) => setForm({ ...form, maxTicketsPerWallet: e.target.value })} /></label>
        <button className="button button-primary" disabled={creating || !wallet.isOrganizer || !wallet.isCorrectNetwork}>{creating ? "Creating on-chain…" : "Create event"}</button>
        {createMessage && <div className={`tx-message tx-${createMessage.type}`} role="status">{createMessage.text}</div>}
      </form>
    </section>;
  }

  if (mode === "events") {
    return <section className="page-section">
      <div className="page-heading"><div><span className="eyebrow">ORGANIZER WORKSPACE</span><h1>My events</h1><p className="muted">Inventory, sales, and active status are read from the contract.</p></div></div>
      {events.length === 0 ? <div className="empty-state"><h3>No events created</h3><p>Create the first event with the organizer wallet.</p></div>
        : <div className="table-wrap"><table><thead><tr><th>Event</th><th>Tickets</th><th>Sold</th><th>Remaining</th><th>Revenue</th><th>Status</th><th>Manage</th></tr></thead><tbody>
          {events.map((event) => <tr key={event.eventId}><td><strong>{event.name}</strong><small>#{event.eventId} · {event.venue}</small></td><td>{event.totalTickets}</td><td>{event.ticketsSold}</td><td>{event.ticketsAvailable}</td><td>{(event.ticketsSold * Number(event.ticketPriceEth)).toFixed(4)} ETH</td><td><span className={`pill ${event.active ? "pill-success" : "pill-neutral"}`}>{event.active ? "Active" : "Inactive"}</span></td><td>{wallet.isOrganizer ? <EventActionButton event={event} contract={contract} refresh={refresh} /> : "Organizer only"}</td></tr>)}
        </tbody></table></div>}
    </section>;
  }

  if (mode === "risk") {
    return <section className="page-section">
      <div className="page-heading"><div><span className="eyebrow">RULE-BASED MONITORING</span><h1>Risk monitor</h1><p className="muted">Heuristic signals from actual on-chain purchases across all events. Shared funding source does not prove common ownership.</p></div><span className="live-label"><i /> Indexed from chain history</span></div>
      <div className="metric-grid metric-grid-4"><Metric label="Tracked wallets" value={riskSummary.trackedWallets} hint="Unique wallets across all events" /><Metric label="Low risk" value={riskSummary.lowRisk} hint="Highest event score per wallet" /><Metric label="Medium risk" value={riskSummary.mediumRisk} hint="Highest event score per wallet" /><Metric label="High risk" value={riskSummary.highRisk} hint="Highest event score per wallet" /></div>
      <div className="content-grid">
        <section className="panel"><div className="panel-heading"><div><h2>Wallet signals</h2><p>Scores are review indicators, not proof of wrongdoing.</p></div></div>
          {riskData.allScores.length === 0 ? <div className="panel-empty">No purchase activity yet.</div> :
            <div className="table-wrap"><table><thead><tr><th>Wallet</th><th>Event</th><th>Tickets purchased</th><th>Purchase transactions</th><th>Score</th><th>Risk level</th><th>Signals</th></tr></thead><tbody>{riskData.allScores.map((row) => <tr key={`${row.eventId}-${row.address}`}><td className="mono" title={row.address}>{row.address.slice(0, 8)}…{row.address.slice(-6)}</td><td>{row.eventName} · #{row.eventId}</td><td>{row.ticketsPurchased}</td><td>{row.purchaseCount}</td><td>{row.score}</td><td><span className={`risk-pill risk-${row.riskLevel.toLowerCase()}`}>{row.riskLevel}</span></td><td>{Object.values(row.signals).filter((signal) => signal.points > 0).map((signal) => signal.detail).join("; ") || "No elevated signals; insufficient activity"}</td></tr>)}</tbody></table></div>}
        </section>
        <section className="panel"><div className="panel-heading"><div><h2>Potential wallet clusters</h2><p>Wallets sharing a funding source within the same event.</p></div></div>
          {riskData.clusters.length === 0 ? <div className="panel-empty">No potential wallet clusters detected.</div> :
            <div className="cluster-list">{riskData.clusters.map((cluster) => <article className="cluster-item" key={`${cluster.eventId}-${cluster.source}`}><strong>Event #{cluster.eventId} · {cluster.members.length} wallets</strong><p className="muted">Shared source {cluster.source.slice(0, 8)}…{cluster.source.slice(-5)} · highest signal score {cluster.maxScore}</p></article>)}</div>}
        </section>
      </div>
      <section className="panel"><div className="panel-heading"><div><h2>Purchase activity</h2><p>Indexed purchase records are reconstructed from contract logs at backend startup.</p></div></div>
        {purchases.length === 0 ? <div className="panel-empty">No purchase activity yet.</div> : <div className="table-wrap"><table><thead><tr><th>Time</th><th>Event</th><th>Buyer</th><th>Quantity</th><th>Ticket IDs</th><th>Value</th><th>Transaction hash</th></tr></thead><tbody>{purchases.slice(0, 50).map((purchase) => <tr key={purchase.txHash}><td>{new Date(purchase.timestamp * 1000).toLocaleString()}</td><td>{purchase.eventName} · #{purchase.eventId}</td><td className="mono" title={purchase.buyer}>{purchase.buyer.slice(0, 8)}…{purchase.buyer.slice(-5)}</td><td>{purchase.quantity}</td><td>{purchase.ticketIds.map((id) => `#${id}`).join(", ")}</td><td>{purchase.totalPriceEth} ETH</td><td className="mono" title={purchase.txHash}>{purchase.txHash?.slice(0, 10)}…{purchase.txHash?.slice(-8)}</td></tr>)}</tbody></table></div>}
      </section>
      <section className="panel"><div className="panel-heading"><div><h2>Ticket review and organizer actions</h2><p>Per-ticket lifecycle state and moderation actions from the deployed contract.</p></div></div>
        {ticketPurchases.length === 0 ? <div className="panel-empty">No purchase activity yet.</div> : <div className="table-wrap"><table><thead><tr><th>Event</th><th>Ticket</th><th>Buyer</th><th>Status</th><th>Risk</th><th>Organizer action</th></tr></thead><tbody>{ticketPurchases.slice(0, 50).map((purchase) => <tr key={`${purchase.txHash}-${purchase.logIndex}`}><td>#{purchase.eventId}</td><td>#{purchase.tokenId}</td><td className="mono" title={purchase.buyer}>{purchase.buyer.slice(0, 8)}…{purchase.buyer.slice(-5)}</td><td><span className="pill pill-neutral">{purchase.status}</span></td><td><span className={`risk-pill risk-${purchase.riskLevel.toLowerCase()}`}>{purchase.riskLevel} · {purchase.riskScore}</span></td><td>{wallet.isOrganizer && ["SOLD", "FROZEN"].includes(purchase.status) ? <div className="table-action"><div className="action-buttons">{purchase.status === "SOLD" ? <button className="button button-secondary button-small" onClick={() => manageTicket(purchase, "freezeTicket")}>Freeze</button> : <button className="button button-secondary button-small" onClick={() => manageTicket(purchase, "clearFlag")}>Clear</button>}<button className="button button-danger button-small" onClick={() => manageTicket(purchase, "revokeAndRefund")}>Revoke & refund</button></div><span>{actionStatus[purchase.tokenId]}</span></div> : "—"}</td></tr>)}</tbody></table></div>}
      </section>
    </section>;
  }

  if (mode === "analytics") {
    return <section className="page-section">
      <div className="page-heading"><div><span className="eyebrow">EVENT PERFORMANCE</span><h1>Analytics</h1><p className="muted">Sales and revenue calculations from contract event inventory.</p></div></div>
      <div className="metric-grid"><Metric label="Total tickets sold" value={totals.totalTicketsSold} /><Metric label="Total tickets remaining" value={totals.totalTicketsRemaining} /><Metric label="Total revenue" value={`${totals.totalRevenueEth} ETH`} hint="Current sold tickets × on-chain event price" /><Metric label="Total unique wallets" value={uniqueWallets} /><Metric label="Total purchase transactions" value={totals.totalPurchaseTransactions} /></div>
      <section className="panel"><div className="panel-heading"><div><h2>Sales by event</h2><p>Ticket sales and current availability from on-chain event records.</p></div></div>
        {events.length === 0 ? <div className="panel-empty">No events available.</div> : purchases.length === 0 ? <div className="panel-empty">Events available — no purchases recorded yet.</div> : <div className="chart-box"><ResponsiveContainer width="100%" height={280}><BarChart data={events}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="name" tick={{ fill: "#64748b", fontSize: 12 }} /><YAxis allowDecimals={false} tick={{ fill: "#64748b" }} /><Tooltip /><Bar dataKey="ticketsSold" name="Tickets sold" fill="#4f46e5" radius={[5, 5, 0, 0]} /><Bar dataKey="ticketsAvailable" name="Remaining" fill="#cbd5e1" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div>}
      </section>
      <section className="panel"><div className="panel-heading"><div><h2>Event revenue and inventory</h2><p>Gross ticket revenue for currently sold tickets, based on each event's price.</p></div></div>
        {events.length === 0 ? <div className="panel-empty">No events available.</div> : <div className="table-wrap"><table><thead><tr><th>Event</th><th>Venue</th><th>Date / time</th><th>Supply</th><th>Sold</th><th>Remaining</th><th>Price</th><th>Revenue</th><th>Unique buyers</th><th>Purchase txns</th><th>Sales %</th><th>Status</th></tr></thead><tbody>{events.map((event) => <tr key={event.eventId}><td><strong>{event.name}</strong><small>#{event.eventId}</small></td><td>{event.venue}</td><td>{event.date} · {event.time}</td><td>{event.totalTickets}</td><td>{event.ticketsSold}</td><td>{event.ticketsAvailable}</td><td>{event.ticketPriceEth} ETH</td><td>{event.revenueEth} ETH</td><td>{event.uniqueBuyers}</td><td>{event.purchaseTransactions}</td><td>{event.salesPercentage.toFixed(1)}%</td><td><span className={`pill ${event.active ? "pill-success" : "pill-neutral"}`}>{event.active ? "Active" : "Inactive"}</span></td></tr>)}<tr className="analytics-total-row"><th colSpan="3">All events total</th><td>{totals.totalTicketSupply}</td><td>{totals.totalTicketsSold}</td><td>{totals.totalTicketsRemaining}</td><td>—</td><td>{totals.totalRevenueEth} ETH</td><td>{totals.uniqueBuyerWallets}</td><td>{totals.totalPurchaseTransactions}</td><td>—</td><td>—</td></tr></tbody></table></div>}
      </section>
      <section className="panel"><div className="panel-heading"><div><h2>Recent purchase transactions</h2><p>Grouped by real transaction hash and reconstructed from indexed purchase events.</p></div></div>
        {purchases.length === 0 ? <div className="panel-empty">Events available — no purchases recorded yet.</div> : <div className="table-wrap"><table><thead><tr><th>Time</th><th>Event</th><th>Buyer</th><th>Quantity</th><th>Ticket IDs</th><th>Value</th><th>Transaction hash</th></tr></thead><tbody>{purchases.slice(0, 50).map((purchase) => <tr key={purchase.txHash}><td>{new Date(purchase.timestamp * 1000).toLocaleString()}</td><td>{purchase.eventName} · #{purchase.eventId}</td><td className="mono" title={purchase.buyer}>{purchase.buyer.slice(0, 8)}…{purchase.buyer.slice(-5)}</td><td>{purchase.quantity}</td><td>{purchase.ticketIds.map((id) => `#${id}`).join(", ")}</td><td>{purchase.totalPriceEth} ETH</td><td className="mono" title={purchase.txHash}>{purchase.txHash?.slice(0, 10)}…{purchase.txHash?.slice(-8)}</td></tr>)}</tbody></table></div>}
      </section>
      <section className="panel"><div className="panel-heading"><div><h2>Revenue by event</h2><p>Revenue uses each event's current on-chain sold count and ticket price.</p></div></div>
        {events.length === 0 ? <div className="panel-empty">No events available.</div> : <div className="chart-box"><ResponsiveContainer width="100%" height={260}><BarChart data={events}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="name" tick={{ fill: "#64748b", fontSize: 12 }} /><YAxis tick={{ fill: "#64748b" }} /><Tooltip formatter={(value) => [`${Number(value).toFixed(4)} ETH`, "Revenue"]} /><Bar dataKey="revenueEthNumber" name="Revenue (ETH)" fill="#0f9f79" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div>}
      </section>
    </section>;
  }

  return <section className="page-section">
    <div className="page-heading"><div><span className="eyebrow">ORGANIZER OVERVIEW</span><h1>Dashboard</h1><p className="muted">Live event performance and blockchain-derived ticket activity.</p></div><span className="live-label"><i /> Chain indexed</span></div>
    <div className="metric-grid"><Metric label="Active events" value={totals.activeEvents} /><Metric label="Tickets sold" value={totals.totalTicketsSold} /><Metric label="Tickets remaining" value={totals.totalTicketsRemaining} /><Metric label="Revenue" value={`${totals.totalRevenueEth} ETH`} hint="Based on current on-chain sales" /><Metric label="Unique wallets" value={uniqueWallets} hint="Distinct purchasers across events" /><Metric label="Purchase transactions" value={totals.totalPurchaseTransactions} /></div>
    <section className="panel"><div className="panel-heading"><div><h2>Sales by event</h2><p>On-chain sold and remaining ticket counts.</p></div></div>
      {events.length === 0 ? <div className="panel-empty">No events available.</div> : <div className="chart-box"><ResponsiveContainer width="100%" height={260}><BarChart data={events}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="name" tick={{ fill: "#64748b", fontSize: 12 }} /><YAxis allowDecimals={false} tick={{ fill: "#64748b" }} /><Tooltip /><Bar dataKey="ticketsSold" name="Tickets sold" fill="#4f46e5" radius={[5, 5, 0, 0]} /><Bar dataKey="ticketsAvailable" name="Remaining" fill="#cbd5e1" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div>}
    </section>
    {purchases.length === 0 && events.length > 0 && <div className="notice">Events available — no purchases recorded yet.</div>}
    <section className="panel"><div className="panel-heading"><div><h2>Event performance</h2><p>Sales and status reconcile to the deployed multi-event contract.</p></div></div>
      {events.length === 0 ? <div className="panel-empty">No events available.</div> : <div className="table-wrap"><table><thead><tr><th>Event</th><th>Supply</th><th>Sold</th><th>Remaining</th><th>Revenue</th><th>Status</th></tr></thead><tbody>{events.map((event) => <tr key={event.eventId}><td><strong>{event.name}</strong><small>{event.venue} · {event.date} · {event.time}</small></td><td>{event.totalTickets}</td><td>{event.ticketsSold}</td><td>{event.ticketsAvailable}</td><td>{event.revenueEth} ETH</td><td><span className={`pill ${event.active ? "pill-success" : "pill-neutral"}`}>{event.active ? "Active" : "Inactive"}</span></td></tr>)}</tbody></table></div>}
    </section>
  </section>;
}
