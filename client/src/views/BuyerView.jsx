import React, { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import { useContract } from "../hooks/useContract";
import { API_BASE } from "../contractConfig";
import StatusBadge from "../components/StatusBadge";

const statusLabel = (status) => {
  if (status === "SOLD") return "VALID";
  if (status === "USED") return "USED";
  return status;
};

function EventCard({ event, onOpen }) {
  return (
    <article className="event-card">
      <div className="event-card__top">
        <span className="eyebrow">EVENT · #{event.eventId}</span>
        <span className={`pill ${event.active ? "pill-success" : "pill-neutral"}`}>
          {event.active ? "On sale" : "Inactive"}
        </span>
      </div>
      <h3>{event.name}</h3>
      <p className="muted">{event.venue}</p>
      <div className="event-meta">
        <span>{event.date}</span><span>{event.time}</span>
      </div>
      <div className="event-card__bottom">
        <div>
          <strong>{event.ticketPriceEth} ETH</strong>
          <span className="muted block">{event.ticketsAvailable} left · max {event.maxTicketsPerWallet} / wallet</span>
        </div>
        <button className="button button-primary" onClick={() => onOpen(event.eventId)}>
          View event
        </button>
      </div>
    </article>
  );
}

export default function BuyerView({ mode, eventId, onOpenEvent, onNavigate, wallet, socketData }) {
  const { account, signer, provider, isCorrectNetwork } = wallet;
  const writeContract = useContract(signer);
  const readContract = useContract(provider);
  const [events, setEvents] = useState([]);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [walletEventCount, setWalletEventCount] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tx, setTx] = useState(null);

  const refreshEvents = useCallback(async () => {
    const response = await fetch(`${API_BASE}/api/events`);
    if (!response.ok) throw new Error("Unable to load events from the blockchain service.");
    const result = await response.json();
    setEvents(result);
    return result;
  }, []);

  const refreshTickets = useCallback(async (eventList = []) => {
    if (!readContract || !account) {
      setTickets([]);
      return;
    }
    const owned = [];
    const purchaseResponse = await fetch(`${API_BASE}/api/purchases`);
    if (!purchaseResponse.ok) throw new Error("Unable to load ticket history.");
    const historicalPurchases = await purchaseResponse.json();
    for (const event of eventList) {
      const ids = await readContract.getWalletTickets(event.eventId, account);
      for (const id of ids) {
        const info = await readContract.getTicketInfo(id);
        owned.push({
          eventId: event.eventId,
          eventName: event.name,
          tokenId: Number(id),
          seatNumber: Number(info.seatNumber),
          status: ["AVAILABLE", "SOLD", "FROZEN", "USED"][Number(info.status)],
          owner: info.owner,
          pricePaid: ethers.formatEther(info.pricePaid),
          purchaseTime: Number(info.purchaseTime),
          txHash: historicalPurchases.find((purchase) => purchase.tokenId === Number(id))?.txHash,
        });
      }
    }
    for (const history of historicalPurchases) {
      if (
        history.status === "REVOKED" &&
        history.previousOwner?.toLowerCase() === account.toLowerCase() &&
        !owned.some((ticket) => ticket.tokenId === history.tokenId)
      ) {
        const event = eventList.find((item) => item.eventId === history.eventId);
        owned.push({
          eventId: history.eventId,
          eventName: event?.name || `Event #${history.eventId}`,
          tokenId: history.tokenId,
          seatNumber: history.seatNumber,
          status: "REVOKED",
          owner: null,
          pricePaid: history.refundAmountEth || "0",
          purchaseTime: history.purchaseTime,
          txHash: history.txHash,
        });
      }
    }
    setTickets(owned.sort((a, b) => b.purchaseTime - a.purchaseTime));
  }, [readContract, account]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    refreshEvents()
      .then(async (result) => {
        if (!active) return;
        setError("");
        await refreshTickets(result);
      })
      .catch((cause) => {
        if (active) setError(cause.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [refreshEvents, refreshTickets]);

  useEffect(() => {
    if (!socketData?.latestPurchase) return;
    refreshEvents().then(refreshTickets).catch((cause) => setError(cause.message));
  }, [socketData?.latestPurchase, refreshEvents, refreshTickets]);

  useEffect(() => {
    if (!eventId || events.length === 0) {
      setSelectedEvent(null);
      return;
    }
    setSelectedEvent(events.find((event) => event.eventId === Number(eventId)) ?? null);
    setQuantity(1);
  }, [eventId, events]);

  useEffect(() => {
    let live = true;
    if (!readContract || !account || !selectedEvent) {
      setWalletEventCount(0);
      return () => { live = false; };
    }
    readContract.walletTicketCount(selectedEvent.eventId, account)
      .then((count) => { if (live) setWalletEventCount(Number(count)); })
      .catch((cause) => { if (live) setError(cause.message); });
    return () => { live = false; };
  }, [readContract, account, selectedEvent]);

  useEffect(() => {
    if (!selectedEvent) return;
    const limitRemaining = Math.max(
      0,
      selectedEvent.maxTicketsPerWallet - walletEventCount
    );
    const quantityLimit = Math.min(selectedEvent.ticketsAvailable, limitRemaining);
    setQuantity((current) => Math.max(1, Math.min(current, quantityLimit || 1)));
  }, [selectedEvent, walletEventCount]);

  const buy = async () => {
    if (wallet.isOrganizer) {
      setTx({ state: "error", message: "Organizer wallets cannot purchase tickets." });
      return;
    }
    if (!writeContract || !selectedEvent || !account) {
      setTx({ state: "error", message: "Connect your wallet to purchase a ticket." });
      return;
    }
    if (!isCorrectNetwork) {
      setTx({ state: "error", message: "Switch MetaMask to Hardhat Local (chain 31337)." });
      return;
    }
    setTx({ state: "pending", message: "Confirm the purchase in MetaMask." });
    try {
      const available = await writeContract.getAvailableTickets(selectedEvent.eventId);
      const ticketIds = Array.from(available).slice(0, quantity);
      if (ticketIds.length !== quantity) throw new Error("The requested tickets are no longer available.");
      const price = BigInt(selectedEvent.ticketPriceWei) * BigInt(quantity);
      const transaction = quantity === 1
        ? await writeContract.buyTicket(selectedEvent.eventId, ticketIds[0], { value: price })
        : await writeContract.buyTickets(selectedEvent.eventId, ticketIds, { value: price });
      setTx({ state: "confirming", message: "Transaction submitted. Waiting for confirmation.", hash: transaction.hash });
      await transaction.wait();
      setTx({ state: "success", message: `${quantity} ticket${quantity === 1 ? "" : "s"} purchased on-chain.`, hash: transaction.hash });
      const nextEvents = await refreshEvents();
      await refreshTickets(nextEvents);
    } catch (cause) {
      setTx({ state: "error", message: cause?.shortMessage || cause?.reason || cause?.message || "Transaction failed." });
    }
  };

  const timeLabel = (timestamp) => timestamp
    ? new Date(timestamp * 1000).toLocaleString()
    : "—";

  if (wallet.isOrganizer) {
    return <section className="page-section">
      <div className="notice notice-warning">Organizer wallets manage events and monitor ticket activity. They cannot use attendee purchase flows.</div>
      <button className="button button-primary" onClick={() => onNavigate("dashboard")}>Go to organizer dashboard</button>
    </section>;
  }

  if (mode === "home") {
    return (
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">TRUSTTIX · ON-CHAIN TICKETING</span>
          <h1>Find your next<br /><span>live experience.</span></h1>
          <p>Blockchain-powered event ticketing with verifiable ownership, transparent availability, and wallet-based access.</p>
          <div className="hero-actions">
            <button className="button button-primary" onClick={() => onNavigate("events")}>Explore events</button>
            {!account && <button className="button button-secondary" onClick={wallet.connect}>Connect wallet</button>}
          </div>
          <div className="feature-row">
            <span>Secure on-chain ownership</span><span>Transparent availability</span><span>Wallet-based access</span>
          </div>
        </div>
        <div className="hero-panel">
          <div className="hero-panel__icon">T</div>
          <p className="eyebrow">BUILT FOR LIVE EVENTS</p>
          <h2>One ticket.<br />One verifiable record.</h2>
          <p className="muted">Purchases and ticket state are recorded by the TrustTix smart contract.</p>
          <button className="text-button" onClick={() => onNavigate("events")}>Browse on-chain events <span>→</span></button>
        </div>
      </section>
    );
  }

  if (mode === "tickets") {
    return (
      <section className="page-section">
        <div className="page-heading"><div><span className="eyebrow">YOUR COLLECTION</span><h1>My tickets</h1><p className="muted">Ticket ownership and status read directly from the contract.</p></div></div>
        {!account ? <div className="empty-state"><h3>Connect your wallet</h3><p>Connect the wallet that owns your tickets to view them here.</p></div>
          : tickets.length === 0 ? <div className="empty-state"><h3>No tickets in this wallet yet</h3><p>Tickets you own on-chain will appear here.</p><button className="button button-primary" onClick={() => onNavigate("events")}>Explore events</button></div>
            : <div className="ticket-grid">{tickets.map((ticket) => <article className="ticket-card" key={ticket.tokenId}>
              <div className="ticket-card__header"><span className="eyebrow">TRUSTTIX · EVENT #{ticket.eventId}</span><StatusBadge status={statusLabel(ticket.status)} /></div>
              <h3>{ticket.eventName}</h3><p className="muted">Ticket #{ticket.tokenId} · Seat {ticket.seatNumber}</p>
              <dl><div><dt>Owner</dt><dd className="mono">{ticket.owner ? `${ticket.owner.slice(0, 8)}…${ticket.owner.slice(-6)}` : "No current owner"}</dd></div><div><dt>{ticket.status === "REVOKED" ? "Refunded" : "Paid"}</dt><dd>{ticket.pricePaid} ETH</dd></div><div><dt>Purchased</dt><dd>{timeLabel(ticket.purchaseTime)}</dd></div>{ticket.txHash && <div><dt>Transaction</dt><dd className="mono">{ticket.txHash.slice(0, 9)}…{ticket.txHash.slice(-6)}</dd></div>}</dl>
            </article>)}</div>}
      </section>
    );
  }

  if (loading) return <div className="empty-state">Loading events...</div>;
  if (error) return <div className="error-panel">{error}</div>;

  if (mode === "detail" && selectedEvent) {
    const maxAllowed = Math.min(
      selectedEvent.ticketsAvailable,
      Math.max(0, selectedEvent.maxTicketsPerWallet - walletEventCount)
    );
    return (
      <section className="page-section">
        <button className="text-button back-button" onClick={() => onNavigate("events")}>← All events</button>
        <div className="detail-layout">
          <article className="detail-card">
            <span className={`pill ${selectedEvent.active ? "pill-success" : "pill-neutral"}`}>{selectedEvent.active ? "On sale" : "Inactive"}</span>
            <span className="eyebrow block">EVENT #{selectedEvent.eventId}</span>
            <h1>{selectedEvent.name}</h1>
            <p className="detail-venue">{selectedEvent.venue}</p>
            <div className="detail-meta"><div><span>Date</span><strong>{selectedEvent.date}</strong></div><div><span>Time</span><strong>{selectedEvent.time}</strong></div><div><span>Availability</span><strong>{selectedEvent.ticketsAvailable} tickets</strong></div></div>
            <p className="muted">Maximum {selectedEvent.maxTicketsPerWallet} tickets per wallet for this event.</p>
          </article>
          <aside className="purchase-card">
            <span className="eyebrow">TICKET PRICE</span><strong className="price-large">{selectedEvent.ticketPriceEth} <small>ETH</small></strong>
            <label className="form-label" htmlFor="quantity">Quantity</label>
            <input id="quantity" className="form-input" type="number" min="1" max={Math.max(1, maxAllowed)} value={quantity} disabled={!selectedEvent.active || maxAllowed === 0} onChange={(event) => setQuantity(Math.max(1, Math.min(maxAllowed || 1, Number(event.target.value) || 1)))} />
            <div className="total-line"><span>Total</span><strong>{ethers.formatEther(BigInt(selectedEvent.ticketPriceWei) * BigInt(quantity))} ETH</strong></div>
            {!account ? <p className="notice">Connect your wallet to buy tickets.</p>
              : !isCorrectNetwork ? <p className="notice notice-warning">Switch to Hardhat Local (31337) in MetaMask.</p>
                : null}
            <button className="button button-primary button-full" onClick={buy} disabled={!account || !isCorrectNetwork || !selectedEvent.active || maxAllowed === 0}>
              {!selectedEvent.active ? "Event inactive"               : maxAllowed === 0 ? selectedEvent.ticketsAvailable === 0 ? "Sold out" : "Wallet limit reached" : "Buy tickets"}
            </button>
            {tx && <div className={`tx-message tx-${tx.state}`} role="status"><strong>{tx.state === "pending" ? "Confirm in MetaMask" : tx.state === "confirming" ? "Transaction pending" : tx.state === "success" ? "Purchase confirmed" : "Purchase failed"}</strong><p>{tx.message}</p>{tx.hash && <code>{tx.hash}</code>}</div>}
          </aside>
        </div>
      </section>
    );
  }

  return (
    <section className="page-section">
      <div className="page-heading"><div><span className="eyebrow">DISCOVER</span><h1>Events</h1><p className="muted">Browse events registered on the TrustTix blockchain.</p></div><span className="count-chip">{events.filter((event) => event.active).length} active</span></div>
      {events.length === 0 ? <div className="empty-state"><h3>No events available</h3><p>New events appear here after an organizer creates them on-chain.</p></div>
        : <div className="event-grid">{events.map((event) => <EventCard key={event.eventId} event={event} onOpen={onOpenEvent} />)}</div>}
    </section>
  );
}
