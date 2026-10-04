import React, { useEffect, useMemo, useState } from "react";
import { useWallet } from "./hooks/useWallet";
import { useSocket } from "./hooks/useSocket";
import { useContract } from "./hooks/useContract";
import { CONTRACT_ADDRESS } from "./contractConfig";
import WalletBar from "./components/WalletBar";
import BuyerView from "./views/BuyerView";
import OrganizerView from "./views/OrganizerView";
import GateView from "./views/GateView";

const ATTENDEE_NAV = [
  { id: "home", label: "Home" },
  { id: "events", label: "Events" },
  { id: "tickets", label: "My tickets" },
  { id: "gate", label: "Verify ticket" },
];
const ORGANIZER_NAV = [
  { id: "dashboard", label: "Dashboard" },
  { id: "my-events", label: "My events" },
  { id: "create-event", label: "Create event" },
  { id: "analytics", label: "Analytics" },
  { id: "risk", label: "Risk monitor" },
];

export default function App() {
  const walletState = useWallet();
  const socketData = useSocket();
  const readContract = useContract(walletState.provider);
  const [activeView, setActiveView] = useState("home");
  const [selectedEventId, setSelectedEventId] = useState(null);
  const [role, setRole] = useState({ name: "Connect wallet", organizer: false, staff: false, loading: false });

  useEffect(() => {
    let live = true;
    if (!walletState.account || !readContract || !walletState.isCorrectNetwork) {
      setRole({ name: "Attendee", organizer: false, staff: false, loading: false });
      return () => { live = false; };
    }
    setRole((current) => ({ ...current, loading: true }));
    Promise.all([readContract.owner(), readContract.isStaff(walletState.account)])
      .then(([owner, isStaff]) => {
        if (!live) return;
        const isOrganizer = owner.toLowerCase() === walletState.account.toLowerCase();
        setRole({
          name: isOrganizer ? "Organizer" : isStaff ? "Gate operator" : "Attendee",
          organizer: isOrganizer,
          staff: isStaff,
          loading: false,
        });
      })
      .catch(() => {
        if (live) setRole({ name: "Role unavailable", organizer: false, staff: false, loading: false });
      });
    return () => { live = false; };
  }, [walletState.account, walletState.isCorrectNetwork, readContract]);

  const wallet = useMemo(() => ({
    ...walletState,
    role: role.name,
    isOrganizer: role.organizer,
    isStaff: role.staff,
    roleLoading: role.loading,
  }), [walletState, role]);
  const roleReady = !walletState.account ||
    (!role.loading && role.name !== "Connect wallet" && role.name !== "Role unavailable");
  const nav = !roleReady ? [] : role.organizer ? ORGANIZER_NAV : ATTENDEE_NAV;
  const organizerViews = ["dashboard", "my-events", "create-event", "analytics", "risk"];
  const requestedOrganizerPage = organizerViews.includes(activeView);
  const currentView = roleReady && role.organizer && !requestedOrganizerPage
    ? "dashboard"
    : roleReady && !role.organizer && requestedOrganizerPage
      ? "home"
      : activeView;
  const isOrganizerPage = organizerViews.includes(currentView);

  const navigate = (view) => {
    setSelectedEventId(null);
    setActiveView(view);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const openEvent = (eventId) => {
    setSelectedEventId(eventId);
    setActiveView("event-detail");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="header-inner">
          <button className="brand" onClick={() => navigate("home")} aria-label="TrustTix home">
            <span className="brand-mark">T</span>
            <span><strong>TrustTix</strong><small>ON-CHAIN TICKETING</small></span>
          </button>
          <nav className="main-nav" aria-label="Main navigation">
            {nav.map((item) => <button key={item.id} className={currentView === item.id ? "nav-link nav-link-active" : "nav-link"} onClick={() => navigate(item.id)}>{item.label}</button>)}
          </nav>
          <WalletBar wallet={wallet} />
        </div>
      </header>

      {wallet.account && !wallet.isCorrectNetwork && <div className="network-warning">
        <div><strong>Wrong network</strong><span>Switch MetaMask to Hardhat Local · Chain ID 31337 to use TrustTix.</span></div>
        <button className="button button-secondary button-small" onClick={wallet.addHardhatNetwork}>Add local network</button>
      </div>}

      <main className={`main-content ${isOrganizerPage ? "main-content-wide" : ""}`}>
        {!roleReady && <div className="empty-state">{role.name === "Role unavailable" ? "Unable to determine wallet role from the contract. Reconnect before continuing." : "Checking wallet role on-chain…"}</div>}
        {roleReady && !role.organizer && currentView === "home" && <BuyerView mode="home" onNavigate={navigate} wallet={wallet} socketData={socketData} />}
        {roleReady && !role.organizer && currentView === "events" && <BuyerView mode="events" onOpenEvent={openEvent} onNavigate={navigate} wallet={wallet} socketData={socketData} />}
        {roleReady && !role.organizer && currentView === "event-detail" && <BuyerView mode="detail" eventId={selectedEventId} onOpenEvent={openEvent} onNavigate={navigate} wallet={wallet} socketData={socketData} />}
        {roleReady && !role.organizer && currentView === "tickets" && <BuyerView mode="tickets" onNavigate={navigate} wallet={wallet} socketData={socketData} />}
        {roleReady && !role.organizer && currentView === "gate" && <GateView wallet={wallet} />}
        {roleReady && role.organizer && currentView === "dashboard" && <OrganizerView mode="dashboard" wallet={wallet} socketData={socketData} />}
        {roleReady && role.organizer && currentView === "my-events" && <OrganizerView mode="events" wallet={wallet} socketData={socketData} />}
        {roleReady && role.organizer && currentView === "create-event" && <OrganizerView mode="create" wallet={wallet} socketData={socketData} />}
        {roleReady && role.organizer && currentView === "analytics" && <OrganizerView mode="analytics" wallet={wallet} socketData={socketData} />}
        {roleReady && role.organizer && currentView === "risk" && <OrganizerView mode="risk" wallet={wallet} socketData={socketData} />}
      </main>

      <footer className="site-footer">
        <span>TrustTix · Blockchain-powered event ticketing</span>
        <span className="mono">Contract {CONTRACT_ADDRESS.slice(0, 10)}…{CONTRACT_ADDRESS.slice(-6)} · Chain 31337</span>
      </footer>
    </div>
  );
}
