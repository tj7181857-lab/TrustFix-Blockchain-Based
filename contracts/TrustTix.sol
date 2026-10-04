// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title TrustTix
 * @dev ERC-721 NFT event ticketing with fraud prevention controls.
 *
 * Roles:
 *   owner  — the address that deployed the contract (event organizer)
 *   staff  — addresses granted "gate staff" role; can call markUsed
 *
 * Ticket lifecycle:
 *   AVAILABLE -> (buyTicket) -> SOLD
 *   SOLD      -> (freezeTicket) -> FROZEN
 *   FROZEN    -> (clearFlag)    -> SOLD      (false positive cleared)
 *   FROZEN    -> (revokeAndRefund) -> AVAILABLE (re-pooled)
 *   SOLD      -> (revokeAndRefund) -> AVAILABLE (re-pooled)
 *   SOLD      -> (markUsed)    -> USED
 */
contract TrustTix is ERC721, Ownable {
    // ─────────────────────────────────────────────────────────────────────────
    // TYPES & STATE
    // ─────────────────────────────────────────────────────────────────────────

    enum TicketStatus { AVAILABLE, SOLD, FROZEN, USED }

    struct TicketInfo {
        uint256 tokenId;
        uint256 seatNumber;     // human-readable seat (1-indexed)
        TicketStatus status;
        address owner;          // address(0) when AVAILABLE (in pool)
        uint256 pricePaid;      // wei paid at purchase; used for refunds
        uint256 purchaseTime;   // block.timestamp of buyTicket call
    }

    struct EventInfo {
        string  name;
        uint256 totalTickets;
        uint256 priceInWei;
        uint256 maxPerWallet;
        uint256 ticketsSold;
        uint256 ticketsAvailable;
        bool    active;
    }

    // Single event per deployment (one contract = one event)
    EventInfo public eventData;

    // tokenId → TicketInfo
    mapping(uint256 => TicketInfo) private _tickets;

    // Ordered list of available tokenIds (pool)
    uint256[] private _availablePool;
    // Quick lookup: is this tokenId in the pool?
    mapping(uint256 => bool) private _inPool;

    // buyer wallet → number of tickets owned for this event
    mapping(address => uint256) private _walletTicketCount;

    // Gate staff role
    mapping(address => bool) private _isStaff;

    // Next tokenId to mint
    uint256 private _nextTokenId;

    // ─────────────────────────────────────────────────────────────────────────
    // EVENTS
    // ─────────────────────────────────────────────────────────────────────────

    event TicketPurchased(
        uint256 indexed tokenId,
        address indexed buyer,
        uint256 seatNumber,
        uint256 price,
        uint256 timestamp
    );

    event TicketFrozen(
        uint256 indexed tokenId,
        address indexed owner,
        uint256 timestamp
    );

    event TicketRevoked(
        uint256 indexed tokenId,
        address indexed previousOwner,
        uint256 refundAmount,
        uint256 timestamp
    );

    event TicketCleared(
        uint256 indexed tokenId,
        address indexed owner,
        uint256 timestamp
    );

    event TicketUsed(
        uint256 indexed tokenId,
        address indexed holder,
        uint256 timestamp
    );

    event StaffAdded(address indexed account);
    event StaffRemoved(address indexed account);

    // ─────────────────────────────────────────────────────────────────────────
    // MODIFIERS
    // ─────────────────────────────────────────────────────────────────────────

    modifier onlyStaff() {
        require(
            _isStaff[msg.sender] || msg.sender == owner(),
            "TrustTix: caller is not staff or owner"
        );
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CONSTRUCTOR
    // ─────────────────────────────────────────────────────────────────────────

    constructor() ERC721("TrustTix", "TTIX") Ownable(msg.sender) {}

    // ─────────────────────────────────────────────────────────────────────────
    // OWNER SETUP FUNCTIONS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Create the event and pre-mint all ticket NFTs into the pool.
     * @dev Can only be called once (event must not already be active).
     * @param name_         Display name of the event.
     * @param totalTickets_ Number of tickets to create.
     * @param priceInWei_   Purchase price per ticket in wei.
     * @param maxPerWallet_ Max tickets a single wallet may own at one time.
     */
    function createEvent(
        string calldata name_,
        uint256 totalTickets_,
        uint256 priceInWei_,
        uint256 maxPerWallet_
    ) external onlyOwner {
        require(!eventData.active, "TrustTix: event already created");
        require(totalTickets_ > 0, "TrustTix: must have at least one ticket");
        require(priceInWei_ > 0,   "TrustTix: price must be > 0");
        require(maxPerWallet_ > 0, "TrustTix: maxPerWallet must be > 0");

        eventData = EventInfo({
            name:             name_,
            totalTickets:     totalTickets_,
            priceInWei:       priceInWei_,
            maxPerWallet:     maxPerWallet_,
            ticketsSold:      0,
            ticketsAvailable: totalTickets_,
            active:           true
        });

        // Pre-mint all tickets to the contract itself (the "pool")
        for (uint256 i = 0; i < totalTickets_; i++) {
            uint256 tokenId = _nextTokenId++;
            uint256 seat    = i + 1; // seats are 1-indexed

        // Mint to the contract itself (the pool) — use _mint (not _safeMint)
        // because this contract is intentionally a non-ERC721Receiver holder
        // for the pool; _safeMint would revert since the contract doesn't
        // implement onERC721Received.
        _mint(address(this), tokenId);

            _tickets[tokenId] = TicketInfo({
                tokenId:      tokenId,
                seatNumber:   seat,
                status:       TicketStatus.AVAILABLE,
                owner:        address(0),
                pricePaid:    0,
                purchaseTime: 0
            });

            _availablePool.push(tokenId);
            _inPool[tokenId] = true;
        }
    }

    /**
     * @notice Grant gate-staff role to an address.
     */
    function addStaff(address account) external onlyOwner {
        _isStaff[account] = true;
        emit StaffAdded(account);
    }

    /**
     * @notice Revoke gate-staff role from an address.
     */
    function removeStaff(address account) external onlyOwner {
        _isStaff[account] = false;
        emit StaffRemoved(account);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC PURCHASE
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Buy a specific ticket by tokenId.
     * @dev Enforces: correct payment, ticket available, wallet limit.
     *      Transfers NFT from contract pool to msg.sender.
     * @param tokenId The tokenId of the ticket to purchase.
     */
    function buyTicket(uint256 tokenId) external payable {
        require(eventData.active, "TrustTix: no active event");

        TicketInfo storage ticket = _tickets[tokenId];

        require(ticket.status == TicketStatus.AVAILABLE, "TrustTix: ticket not available");
        require(_inPool[tokenId],                         "TrustTix: ticket not in pool");
        require(msg.value == eventData.priceInWei,        "TrustTix: incorrect payment amount");

        // ── WALLET LIMIT — enforced on-chain, not just in the frontend ──────
        require(
            _walletTicketCount[msg.sender] < eventData.maxPerWallet,
            "TrustTix: wallet ticket limit reached"
        );

        // Remove from pool
        _removeFromPool(tokenId);

        // Update ticket record
        ticket.status       = TicketStatus.SOLD;
        ticket.owner        = msg.sender;
        ticket.pricePaid    = msg.value;
        ticket.purchaseTime = block.timestamp;

        // Update counters
        _walletTicketCount[msg.sender]++;
        eventData.ticketsSold++;
        eventData.ticketsAvailable--;

        // Transfer NFT from contract to buyer
        _transfer(address(this), msg.sender, tokenId);

        emit TicketPurchased(
            tokenId,
            msg.sender,
            ticket.seatNumber,
            msg.value,
            block.timestamp
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ORGANIZER ACTIONS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Freeze a ticket: owner keeps NFT but cannot use or transfer it.
     * @dev Ticket must be in SOLD state.
     */
    function freezeTicket(uint256 tokenId) external onlyOwner {
        TicketInfo storage ticket = _tickets[tokenId];
        require(ticket.status == TicketStatus.SOLD, "TrustTix: ticket must be SOLD to freeze");

        ticket.status = TicketStatus.FROZEN;

        emit TicketFrozen(tokenId, ticket.owner, block.timestamp);
    }

    /**
     * @notice Remove frozen status without revoking (false-positive clear).
     * @dev Ticket must be in FROZEN state.
     */
    function clearFlag(uint256 tokenId) external onlyOwner {
        TicketInfo storage ticket = _tickets[tokenId];
        require(ticket.status == TicketStatus.FROZEN, "TrustTix: ticket must be FROZEN to clear");

        ticket.status = TicketStatus.SOLD;

        emit TicketCleared(tokenId, ticket.owner, block.timestamp);
    }

    /**
     * @notice Burn ticket, refund original price to current owner, re-pool a
     *         fresh ticket with the same seat number.
     * @dev Works on SOLD or FROZEN tickets.
     */
    function revokeAndRefund(uint256 tokenId) external onlyOwner {
        TicketInfo storage ticket = _tickets[tokenId];
        require(
            ticket.status == TicketStatus.SOLD || ticket.status == TicketStatus.FROZEN,
            "TrustTix: can only revoke SOLD or FROZEN tickets"
        );
        require(ticket.owner != address(0), "TrustTix: no owner to refund");

        address previousOwner = ticket.owner;
        uint256 refundAmount  = ticket.pricePaid;
        uint256 seat          = ticket.seatNumber;

        // Update wallet count BEFORE burning
        if (_walletTicketCount[previousOwner] > 0) {
            _walletTicketCount[previousOwner]--;
        }

        // Burn the old token
        _burn(tokenId);

        // Clear old ticket record
        delete _tickets[tokenId];

        // Mint a brand new token with the same seat number
        uint256 newTokenId = _nextTokenId++;
        // Also use _mint for re-pooled tickets (same reason as above)
        _mint(address(this), newTokenId);

        _tickets[newTokenId] = TicketInfo({
            tokenId:      newTokenId,
            seatNumber:   seat,
            status:       TicketStatus.AVAILABLE,
            owner:        address(0),
            pricePaid:    0,
            purchaseTime: 0
        });

        _availablePool.push(newTokenId);
        _inPool[newTokenId] = true;

        // Update event counters
        eventData.ticketsSold--;
        eventData.ticketsAvailable++;

        // Refund ETH to previous owner
        (bool success, ) = payable(previousOwner).call{value: refundAmount}("");
        require(success, "TrustTix: refund transfer failed");

        emit TicketRevoked(tokenId, previousOwner, refundAmount, block.timestamp);
    }

    /**
     * @notice Mark a ticket as used at entry (gate scan).
     * @dev Callable by owner or gate staff. Ticket must be SOLD (not frozen).
     */
    function markUsed(uint256 tokenId) external onlyStaff {
        TicketInfo storage ticket = _tickets[tokenId];
        require(ticket.status == TicketStatus.SOLD, "TrustTix: ticket must be SOLD to mark used");

        ticket.status = TicketStatus.USED;

        emit TicketUsed(tokenId, ticket.owner, block.timestamp);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // VIEW FUNCTIONS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Get full info for a single ticket.
     */
    function getTicketInfo(uint256 tokenId)
        external
        view
        returns (TicketInfo memory)
    {
        require(_tickets[tokenId].tokenId == tokenId || _tickets[tokenId].seatNumber > 0,
            "TrustTix: ticket does not exist");
        return _tickets[tokenId];
    }

    /**
     * @notice Get all tokenIds currently owned by a wallet.
     */
    function getWalletTickets(address wallet)
        external
        view
        returns (uint256[] memory)
    {
        uint256 count = _walletTicketCount[wallet];
        uint256[] memory result = new uint256[](count);
        uint256 found = 0;

        for (uint256 i = 0; i < _nextTokenId && found < count; i++) {
            TicketInfo storage t = _tickets[i];
            if (t.owner == wallet &&
                (t.status == TicketStatus.SOLD ||
                 t.status == TicketStatus.FROZEN ||
                 t.status == TicketStatus.USED))
            {
                result[found++] = i;
            }
        }
        return result;
    }

    /**
     * @notice Get all tokenIds currently in the available pool.
     */
    function getAvailableTickets() external view returns (uint256[] memory) {
        return _availablePool;
    }

    /**
     * @notice Get event-level info.
     */
    function getEventInfo() external view returns (EventInfo memory) {
        return eventData;
    }

    /**
     * @notice Check if an address has staff role.
     */
    function isStaff(address account) external view returns (bool) {
        return _isStaff[account];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ERC-721 TRANSFER OVERRIDES (enforce frozen / used restrictions)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @dev Override to block transfers of FROZEN or USED tickets.
     *      Wallet-count bookkeeping is handled explicitly in buyTicket and
     *      revokeAndRefund — we do NOT adjust counts here to avoid double-
     *      counting on the initial contract→buyer transfer in buyTicket.
     */
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = super._ownerOf(tokenId);

        // Only enforce status restrictions on real (non-mint, non-burn) transfers
        // that originate from a user wallet (not from the contract pool itself).
        if (from != address(0) && to != address(0) && from != address(this)) {
            TicketInfo storage ticket = _tickets[tokenId];
            require(
                ticket.status != TicketStatus.FROZEN,
                "TrustTix: frozen tickets cannot be transferred"
            );
            require(
                ticket.status != TicketStatus.USED,
                "TrustTix: used tickets cannot be transferred"
            );

            // Track owner change for secondary transfers (wallet-to-wallet)
            // This path is only reached for peer transfers, NOT for the initial
            // contract→buyer sale (buyTicket handles that count increment).
            if (_walletTicketCount[from] > 0) {
                _walletTicketCount[from]--;
            }
            _walletTicketCount[to]++;
            ticket.owner = to;
        }

        return super._update(to, tokenId, auth);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @dev Remove tokenId from the _availablePool array (swap-and-pop).
     */
    function _removeFromPool(uint256 tokenId) internal {
        require(_inPool[tokenId], "TrustTix: tokenId not in pool");

        uint256 len = _availablePool.length;
        for (uint256 i = 0; i < len; i++) {
            if (_availablePool[i] == tokenId) {
                // Swap with last element and pop
                _availablePool[i] = _availablePool[len - 1];
                _availablePool.pop();
                break;
            }
        }
        _inPool[tokenId] = false;
    }

    /**
     * @dev Required to receive ETH (for the contract to hold funds for refunds).
     */
    receive() external payable {}
}
