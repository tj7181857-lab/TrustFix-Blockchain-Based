require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const express = require("express");
const http = require("http");
const { Server: SocketIOServer } = require("socket.io");
const cors = require("cors");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const { buildAnalytics } = require("./analytics");
const riskEngine = require("./riskEngine");
const ChainListener = require("./chainListener");

const PORT = process.env.PORT || 3001;
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const deploymentPath = path.join(__dirname, "../deployment-multi-event.json");
const abiPath = path.join(__dirname, "TrustTixMultiEvent.json");

if (!fs.existsSync(deploymentPath)) {
  console.error("ERROR: deployment-multi-event.json not found. Deploy TrustTixMultiEvent first.");
  process.exit(1);
}
if (!fs.existsSync(abiPath)) {
  console.error("ERROR: server/TrustTixMultiEvent.json not found. Run the multi-event deployment script.");
  process.exit(1);
}

const deploymentInfo = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
const contractAddress =
  process.env.MULTI_EVENT_CONTRACT_ADDRESS || deploymentInfo.contractAddress;
const contractChainId = Number(deploymentInfo.chainId);
const { abi } = JSON.parse(fs.readFileSync(abiPath, "utf8"));
const provider = new ethers.JsonRpcProvider(RPC_URL);
const readContract = new ethers.Contract(contractAddress, abi, provider);
const listener = new ChainListener(RPC_URL, contractAddress, abi);
if (deploymentInfo.deploymentBlock != null) {
  process.env.MULTI_EVENT_DEPLOYMENT_BLOCK = String(deploymentInfo.deploymentBlock);
}

const app = express();
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});
app.use(cors());
app.use(express.json());

function eventIdFromRequest(value) {
  if (!/^[1-9]\d*$/.test(String(value))) return null;
  const eventId = Number(value);
  return Number.isSafeInteger(eventId) ? eventId : null;
}

function serializeEvent(eventId, info) {
  return {
    eventId,
    name: info.name,
    venue: info.venue,
    date: info.date,
    time: info.time,
    ticketPriceWei: info.ticketPrice.toString(),
    ticketPriceEth: ethers.formatEther(info.ticketPrice),
    totalTickets: Number(info.totalTickets),
    ticketsSold: Number(info.ticketsSold),
    ticketsAvailable: Number(info.ticketsAvailable),
    maxTicketsPerWallet: Number(info.maxTicketsPerWallet),
    active: info.active,
    organizer: info.organizer,
  };
}

async function readTicketOrRevoked(tokenId) {
  try {
    const ticket = await readContract.getTicketInfo(tokenId);
    return {
      eventId: Number(ticket.eventId),
      tokenId: Number(ticket.tokenId),
      seatNumber: Number(ticket.seatNumber),
      status: ["AVAILABLE", "SOLD", "FROZEN", "USED"][Number(ticket.status)],
      owner: ticket.owner,
      pricePaidEth: ethers.formatEther(ticket.pricePaid),
      purchaseTime: Number(ticket.purchaseTime),
    };
  } catch (ticketError) {
    const filter = readContract.filters.TicketRevoked(null, tokenId);
    const logs = await readContract.queryFilter(
      filter,
      Number(deploymentInfo.deploymentBlock || 0),
      "latest"
    );
    const revoked = logs.at(-1);
    if (revoked) {
      const [eventId, revokedTokenId, replacementTokenId, previousOwner, refundAmount, timestamp] =
        revoked.args;
      const purchaseLogs = await readContract.queryFilter(
        readContract.filters.TicketPurchased(null, revokedTokenId),
        Number(deploymentInfo.deploymentBlock || 0),
        revoked.blockNumber
      );
      const originalPurchase = purchaseLogs.at(-1);
      return {
        eventId: Number(eventId),
        tokenId: Number(revokedTokenId),
        replacementTokenId: Number(replacementTokenId),
        seatNumber: originalPurchase ? Number(originalPurchase.args.seatNumber) : null,
        status: "REVOKED",
        owner: null,
        previousOwner,
        refundAmountEth: ethers.formatEther(refundAmount),
        purchaseTime: originalPurchase
          ? Number(originalPurchase.args.timestamp)
          : Number(timestamp),
        revokedAt: Number(timestamp),
      };
    }
    throw ticketError;
  }
}

async function loadEvents(activeOnly = false) {
  const ids = activeOnly
    ? await readContract.getActiveEventIds()
    : await readContract.getEventIds();
  return Promise.all(
    ids.map(async (id) => {
      const eventId = Number(id);
      return serializeEvent(eventId, await readContract.getEventDetails(eventId));
    })
  );
}

async function loadIndexedPurchases(eventId = null) {
  const purchases = riskEngine.getPurchases(eventId);
  const ticketState = new Map();
  for (const purchase of purchases) {
    if (ticketState.has(purchase.tokenId)) continue;
    ticketState.set(purchase.tokenId, await readTicketOrRevoked(purchase.tokenId));
  }
  return purchases.map((purchase) => ({
    ...purchase,
    ...ticketState.get(purchase.tokenId),
  }));
}

function currentRiskUpdate(eventId = null) {
  return {
    allScores: riskEngine.getAllRiskScores(eventId),
    clusters: riskEngine.getClusters(eventId),
    graph: riskEngine.getGraphData(eventId),
  };
}

listener.on("newPurchase", (data) => {
  io.emit("newPurchase", data);
  io.emit("riskUpdate", currentRiskUpdate());
});
listener.on("walletFlagged", (data) => io.emit("walletFlagged", data));
for (const eventName of ["ticketFrozen", "ticketRevoked", "ticketCleared", "ticketUsed"]) {
  listener.on(eventName, (data) => {
    io.emit(eventName, data);
    io.emit("riskUpdate", currentRiskUpdate());
  });
}
listener.on("listenerError", (error) => {
  console.error("[Server] Chain listener error:", error);
});

app.get("/api/health", async (req, res) => {
  try {
    const network = await provider.getNetwork();
    res.json({
      status: Number(network.chainId) === contractChainId ? "ok" : "wrong-chain",
      contract: contractAddress,
      contractName: deploymentInfo.contractName,
      rpc: RPC_URL,
      chainId: Number(network.chainId),
      expectedChainId: contractChainId,
      organizer: await readContract.owner(),
      indexedPurchases: riskEngine.getPurchases().length,
    });
  } catch (error) {
    res.status(503).json({ status: "unavailable", error: error.message });
  }
});

app.get("/api/events", async (req, res) => {
  try {
    res.json(await loadEvents(req.query.active === "true"));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/analytics", async (req, res) => {
  try {
    const [events, purchases] = await Promise.all([
      loadEvents(),
      loadIndexedPurchases(),
    ]);
    res.json(buildAnalytics(
      events,
      purchases,
      riskEngine.getAllRiskScores(),
      riskEngine.getClusters()
    ));
  } catch (error) {
    res.status(503).json({
      status: "contract-unavailable",
      error: error.message,
    });
  }
});

app.get("/api/events/:eventId", async (req, res) => {
  const eventId = eventIdFromRequest(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "Invalid event ID" });
  try {
    res.json(serializeEvent(eventId, await readContract.getEventDetails(eventId)));
  } catch (error) {
    res.status(404).json({ error: "Event not found" });
  }
});

app.get("/api/events/:eventId/purchases", (req, res) => {
  const eventId = eventIdFromRequest(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "Invalid event ID" });
  res.json(riskEngine.getPurchases(eventId));
});

app.get("/api/events/:eventId/risk", (req, res) => {
  const eventId = eventIdFromRequest(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "Invalid event ID" });
  res.json({
    allScores: riskEngine.getAllRiskScores(eventId),
    clusters: riskEngine.getClusters(eventId),
    graph: riskEngine.getGraphData(eventId),
  });
});

app.get("/api/events/:eventId/tickets", async (req, res) => {
  const eventId = eventIdFromRequest(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "Invalid event ID" });
  try {
    const [eventInfo, availableTokenIds] = await Promise.all([
      readContract.getEventDetails(eventId),
      readContract.getAvailableTickets(eventId),
    ]);
    const purchases = riskEngine.getPurchases(eventId);
    const seen = new Set();
    const purchasedTickets = [];
    for (const purchase of purchases) {
      if (seen.has(purchase.tokenId)) continue;
      seen.add(purchase.tokenId);
      try {
        purchasedTickets.push({ ...purchase, ...(await readTicketOrRevoked(purchase.tokenId)) });
      } catch (error) {
        throw error;
      }
    }
    res.json({
      event: serializeEvent(eventId, eventInfo),
      availableTokenIds: availableTokenIds.map(String),
      purchasedTickets,
    });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.get("/api/risk-scores", (req, res) => {
  const eventId = req.query.eventId == null ? null : eventIdFromRequest(req.query.eventId);
  if (req.query.eventId != null && !eventId) return res.status(400).json({ error: "Invalid event ID" });
  res.json(riskEngine.getAllRiskScores(eventId));
});
app.get("/api/clusters", (req, res) => {
  const eventId = req.query.eventId == null ? null : eventIdFromRequest(req.query.eventId);
  if (req.query.eventId != null && !eventId) return res.status(400).json({ error: "Invalid event ID" });
  res.json(riskEngine.getClusters(eventId));
});
app.get("/api/graph", (req, res) => {
  const eventId = req.query.eventId == null ? null : eventIdFromRequest(req.query.eventId);
  if (req.query.eventId != null && !eventId) return res.status(400).json({ error: "Invalid event ID" });
  res.json(riskEngine.getGraphData(eventId));
});
app.get("/api/purchases", async (req, res) => {
  const eventId = req.query.eventId == null ? null : eventIdFromRequest(req.query.eventId);
  if (req.query.eventId != null && !eventId) return res.status(400).json({ error: "Invalid event ID" });
  try {
    res.json(await loadIndexedPurchases(eventId));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/ticket/:tokenId", async (req, res) => {
  if (!/^\d+$/.test(req.params.tokenId)) {
    return res.status(400).json({ error: "Invalid ticket ID" });
  }
  try {
    const tokenId = Number(req.params.tokenId);
    res.json(await readTicketOrRevoked(tokenId));
  } catch {
    res.status(404).json({ error: "Ticket not found or revoked" });
  }
});

app.get("/api/role/:address", async (req, res) => {
  if (!ethers.isAddress(req.params.address)) {
    return res.status(400).json({ error: "Invalid wallet address" });
  }
  try {
    const [organizer, staff] = await Promise.all([
      readContract.owner(),
      readContract.isStaff(req.params.address),
    ]);
    res.json({
      address: ethers.getAddress(req.params.address),
      organizer: organizer.toLowerCase() === req.params.address.toLowerCase(),
      staff,
      role:
        organizer.toLowerCase() === req.params.address.toLowerCase()
          ? "Organizer"
          : staff
            ? "Gate operator"
            : "Attendee",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

io.on("connection", (socket) => {
  socket.emit("riskUpdate", currentRiskUpdate());
  socket.emit("purchaseHistory", riskEngine.getPurchases());
});

async function start() {
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== contractChainId) {
    throw new Error(
      `RPC chain ${network.chainId} does not match deployment chain ${contractChainId}`
    );
  }
  console.log("\n=== TrustTix Multi-Event API ===");
  console.log("Contract:", contractAddress);
  console.log("RPC:", RPC_URL);
  await listener.start();
  httpServer.listen(PORT, () => {
    console.log(`Backend ready at http://localhost:${PORT} (chain ${contractChainId})`);
  });
}

start().catch((error) => {
  console.error("[Server] Startup failed:", error);
  process.exit(1);
});
