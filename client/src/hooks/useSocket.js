/**
 * useSocket.js
 *
 * Manages a Socket.io connection to the backend detection service.
 * Returns the socket instance and the latest event state.
 */

import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { API_BASE } from "../contractConfig";

export function useSocket() {
  const socketRef = useRef(null);
  const [isConnected, setIsConnected] = useState(false);
  const [latestPurchase, setLatestPurchase] = useState(null);
  const [riskData, setRiskData] = useState({ allScores: [], clusters: [], graph: { nodes: [], edges: [] } });
  const [flaggedWallets, setFlaggedWallets] = useState([]);
  const [recentEvents, setRecentEvents] = useState([]);

  useEffect(() => {
    const socket = io(API_BASE, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 1000,
    });

    socketRef.current = socket;

    socket.on("connect", () => setIsConnected(true));
    socket.on("disconnect", () => setIsConnected(false));

    socket.on("newPurchase", (data) => {
      setLatestPurchase(data);
      setRecentEvents((prev) => {
        const exists = prev.some((event) =>
          event.data.txHash === data.txHash &&
          String(event.data.logIndex) === String(data.logIndex)
        );
        return exists ? prev : [{ type: "purchase", data, ts: data.timestamp * 1000 }, ...prev].slice(0, 200);
      });
    });

    socket.on("purchaseHistory", (purchases) => {
      const events = purchases.map((data) => ({
        type: "purchase",
        data,
        ts: data.timestamp * 1000,
      }));
      setRecentEvents(events.slice(0, 200));
      if (purchases.length > 0) setLatestPurchase(purchases[0]);
    });

    socket.on("riskUpdate", (data) => {
      setRiskData(data);
    });

    socket.on("walletFlagged", (data) => {
      setFlaggedWallets((prev) => {
        const exists = prev.find((w) => w.buyer === data.buyer);
        if (exists) return prev.map((w) => (w.buyer === data.buyer ? data : w));
        return [data, ...prev];
      });
      setRecentEvents((prev) =>
        [{ type: "flagged", data, ts: Date.now() }, ...prev].slice(0, 50)
      );
    });

    socket.on("ticketFrozen", (data) => {
      setRecentEvents((prev) =>
        [{ type: "frozen", data, ts: Date.now() }, ...prev].slice(0, 50)
      );
    });

    socket.on("ticketRevoked", (data) => {
      setRecentEvents((prev) =>
        [{ type: "revoked", data, ts: Date.now() }, ...prev].slice(0, 50)
      );
    });

    socket.on("ticketCleared", (data) => {
      setRecentEvents((prev) =>
        [{ type: "cleared", data, ts: Date.now() }, ...prev].slice(0, 50)
      );
    });

    socket.on("ticketUsed", (data) => {
      setRecentEvents((prev) =>
        [{ type: "used", data, ts: Date.now() }, ...prev].slice(0, 50)
      );
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  return {
    socket: socketRef.current,
    isConnected,
    latestPurchase,
    riskData,
    flaggedWallets,
    recentEvents,
  };
}
