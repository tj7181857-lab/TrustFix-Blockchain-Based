// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title TrustTixMultiEvent
 * @dev One ERC-721 collection and organizer-managed registry for many events.
 * The contract owner creates events and manages tickets; owner-approved staff
 * can mark valid tickets as used at the gate.
 */
contract TrustTixMultiEvent is ERC721, Ownable {
    enum TicketStatus {
        AVAILABLE,
        SOLD,
        FROZEN,
        USED
    }

    struct EventInfo {
        string name;
        string venue;
        string date;
        string time;
        uint256 ticketPrice;
        uint256 totalTickets;
        uint256 ticketsSold;
        uint256 ticketsAvailable;
        uint256 maxTicketsPerWallet;
        bool active;
        address organizer;
    }

    struct TicketInfo {
        uint256 tokenId;
        uint256 eventId;
        uint256 seatNumber;
        TicketStatus status;
        address owner;
        uint256 pricePaid;
        uint256 purchaseTime;
    }

    uint256 private _nextEventId = 1;
    uint256 private _nextTokenId;

    mapping(uint256 => EventInfo) private _events;
    uint256[] private _eventIds;
    mapping(uint256 => TicketInfo) private _tickets;
    mapping(uint256 => uint256[]) private _availablePoolByEvent;
    mapping(uint256 => mapping(uint256 => bool)) private _inPool;
    mapping(uint256 => mapping(address => uint256)) private _walletTicketCount;
    mapping(address => bool) private _isStaff;

    event EventCreated(
        uint256 indexed eventId,
        address indexed organizer,
        string name,
        string venue,
        string date,
        string time,
        uint256 ticketPrice,
        uint256 totalTickets,
        uint256 maxTicketsPerWallet
    );
    event EventStatusChanged(uint256 indexed eventId, bool active);
    event TicketPurchased(
        uint256 indexed eventId,
        uint256 indexed tokenId,
        address indexed buyer,
        uint256 seatNumber,
        uint256 price,
        uint256 timestamp
    );
    event TicketFrozen(
        uint256 indexed eventId,
        uint256 indexed tokenId,
        address indexed ticketOwner,
        uint256 timestamp
    );
    event TicketCleared(
        uint256 indexed eventId,
        uint256 indexed tokenId,
        address indexed ticketOwner,
        uint256 timestamp
    );
    event TicketRevoked(
        uint256 indexed eventId,
        uint256 indexed tokenId,
        uint256 indexed replacementTokenId,
        address previousOwner,
        uint256 refundAmount,
        uint256 timestamp
    );
    event RefundIssued(
        uint256 indexed eventId,
        uint256 indexed tokenId,
        address indexed recipient,
        uint256 amount
    );
    event TicketUsed(
        uint256 indexed eventId,
        uint256 indexed tokenId,
        address indexed holder,
        uint256 timestamp
    );
    event StaffAdded(address indexed account);
    event StaffRemoved(address indexed account);

    modifier onlyStaff() {
        require(
            _isStaff[msg.sender] || msg.sender == owner(),
            "TrustTix: caller is not staff or owner"
        );
        _;
    }

    modifier onlyAttendee() {
        require(msg.sender != owner(), "TrustTix: organizer cannot buy tickets");
        _;
    }

    constructor() ERC721("TrustTix", "TTIX") Ownable(msg.sender) {}

    /**
     * @notice Create an event and mint its tickets into the contract's pool.
     * Dates and times are stored as display strings supplied by the organizer.
     */
    function createEvent(
        string calldata name_,
        string calldata venue_,
        string calldata date_,
        string calldata time_,
        uint256 ticketPrice_,
        uint256 totalTickets_,
        uint256 maxTicketsPerWallet_
    ) external onlyOwner returns (uint256 eventId) {
        require(bytes(name_).length > 0, "TrustTix: name is required");
        require(bytes(venue_).length > 0, "TrustTix: venue is required");
        require(bytes(date_).length > 0, "TrustTix: date is required");
        require(bytes(time_).length > 0, "TrustTix: time is required");
        require(ticketPrice_ > 0, "TrustTix: price must be > 0");
        require(totalTickets_ > 0, "TrustTix: supply must be > 0");
        require(
            maxTicketsPerWallet_ > 0,
            "TrustTix: maxPerWallet must be > 0"
        );
        require(
            maxTicketsPerWallet_ <= totalTickets_,
            "TrustTix: maxPerWallet exceeds supply"
        );

        eventId = _nextEventId++;
        _events[eventId] = EventInfo({
            name: name_,
            venue: venue_,
            date: date_,
            time: time_,
            ticketPrice: ticketPrice_,
            totalTickets: totalTickets_,
            ticketsSold: 0,
            ticketsAvailable: totalTickets_,
            maxTicketsPerWallet: maxTicketsPerWallet_,
            active: true,
            organizer: msg.sender
        });
        _eventIds.push(eventId);

        for (uint256 seat = 1; seat <= totalTickets_; seat++) {
            uint256 tokenId = _nextTokenId++;
            _mint(address(this), tokenId);
            _tickets[tokenId] = TicketInfo({
                tokenId: tokenId,
                eventId: eventId,
                seatNumber: seat,
                status: TicketStatus.AVAILABLE,
                owner: address(0),
                pricePaid: 0,
                purchaseTime: 0
            });
            _availablePoolByEvent[eventId].push(tokenId);
            _inPool[eventId][tokenId] = true;
        }

        emit EventCreated(
            eventId,
            msg.sender,
            name_,
            venue_,
            date_,
            time_,
            ticketPrice_,
            totalTickets_,
            maxTicketsPerWallet_
        );
    }

    function setEventActive(uint256 eventId, bool active) external onlyOwner {
        _requireEvent(eventId);
        _events[eventId].active = active;
        emit EventStatusChanged(eventId, active);
    }

    function addStaff(address account) external onlyOwner {
        require(account != address(0), "TrustTix: invalid staff address");
        _isStaff[account] = true;
        emit StaffAdded(account);
    }

    function removeStaff(address account) external onlyOwner {
        _isStaff[account] = false;
        emit StaffRemoved(account);
    }

    /**
     * @notice Buy one ticket. The event ID and token ID must refer to the same
     * event; payment and wallet limits are checked on-chain.
     */
    function buyTicket(
        uint256 eventId,
        uint256 tokenId
    ) external payable onlyAttendee {
        EventInfo storage eventInfo = _requireActiveEvent(eventId);
        require(msg.value == eventInfo.ticketPrice, "TrustTix: incorrect payment amount");
        _buyTicket(eventId, tokenId, msg.sender, eventInfo);
    }

    /**
     * @notice Atomically buy several tickets for one event at its exact price.
     */
    function buyTickets(
        uint256 eventId,
        uint256[] calldata tokenIds
    ) external payable onlyAttendee {
        EventInfo storage eventInfo = _requireActiveEvent(eventId);
        uint256 quantity = tokenIds.length;
        require(quantity > 0, "TrustTix: quantity must be > 0");
        require(
            quantity <= eventInfo.ticketsAvailable,
            "TrustTix: insufficient tickets available"
        );
        require(
            quantity <=
                eventInfo.maxTicketsPerWallet -
                    _walletTicketCount[eventId][msg.sender],
            "TrustTix: wallet ticket limit reached"
        );
        require(
            msg.value == eventInfo.ticketPrice * quantity,
            "TrustTix: incorrect payment amount"
        );

        for (uint256 i = 0; i < quantity; i++) {
            _buyTicket(eventId, tokenIds[i], msg.sender, eventInfo);
        }
    }

    function freezeTicket(uint256 tokenId) external onlyOwner {
        TicketInfo storage ticket = _requireTicket(tokenId);
        require(ticket.status == TicketStatus.SOLD, "TrustTix: ticket must be SOLD to freeze");
        ticket.status = TicketStatus.FROZEN;
        emit TicketFrozen(ticket.eventId, tokenId, ticket.owner, block.timestamp);
    }

    function clearFlag(uint256 tokenId) external onlyOwner {
        TicketInfo storage ticket = _requireTicket(tokenId);
        require(ticket.status == TicketStatus.FROZEN, "TrustTix: ticket must be FROZEN to clear");
        ticket.status = TicketStatus.SOLD;
        emit TicketCleared(ticket.eventId, tokenId, ticket.owner, block.timestamp);
    }

    function revokeAndRefund(uint256 tokenId) external onlyOwner {
        TicketInfo storage ticket = _requireTicket(tokenId);
        require(
            ticket.status == TicketStatus.SOLD ||
                ticket.status == TicketStatus.FROZEN,
            "TrustTix: can only revoke SOLD or FROZEN tickets"
        );

        uint256 eventId = ticket.eventId;
        uint256 seat = ticket.seatNumber;
        address previousOwner = ticket.owner;
        uint256 refundAmount = ticket.pricePaid;
        EventInfo storage eventInfo = _events[eventId];

        _walletTicketCount[eventId][previousOwner]--;
        eventInfo.ticketsSold--;
        eventInfo.ticketsAvailable++;
        _burn(tokenId);
        delete _tickets[tokenId];

        uint256 replacementTokenId = _nextTokenId++;
        _mint(address(this), replacementTokenId);
        _tickets[replacementTokenId] = TicketInfo({
            tokenId: replacementTokenId,
            eventId: eventId,
            seatNumber: seat,
            status: TicketStatus.AVAILABLE,
            owner: address(0),
            pricePaid: 0,
            purchaseTime: 0
        });
        _availablePoolByEvent[eventId].push(replacementTokenId);
        _inPool[eventId][replacementTokenId] = true;

        (bool success, ) = payable(previousOwner).call{value: refundAmount}("");
        require(success, "TrustTix: refund transfer failed");

        emit TicketRevoked(
            eventId,
            tokenId,
            replacementTokenId,
            previousOwner,
            refundAmount,
            block.timestamp
        );
        emit RefundIssued(eventId, tokenId, previousOwner, refundAmount);
    }

    function markUsed(uint256 tokenId) external onlyStaff {
        TicketInfo storage ticket = _requireTicket(tokenId);
        require(ticket.status == TicketStatus.SOLD, "TrustTix: ticket must be SOLD to mark used");
        ticket.status = TicketStatus.USED;
        emit TicketUsed(ticket.eventId, tokenId, ticket.owner, block.timestamp);
    }

    function getEventDetails(uint256 eventId) external view returns (EventInfo memory) {
        _requireEvent(eventId);
        return _events[eventId];
    }

    function getEventCount() external view returns (uint256) {
        return _eventIds.length;
    }

    function getEventIds() external view returns (uint256[] memory) {
        return _eventIds;
    }

    function getActiveEventIds() external view returns (uint256[] memory) {
        uint256 activeCount;
        for (uint256 i = 0; i < _eventIds.length; i++) {
            if (_events[_eventIds[i]].active) activeCount++;
        }

        uint256[] memory activeIds = new uint256[](activeCount);
        uint256 resultIndex;
        for (uint256 i = 0; i < _eventIds.length; i++) {
            uint256 eventId = _eventIds[i];
            if (_events[eventId].active) activeIds[resultIndex++] = eventId;
        }
        return activeIds;
    }

    function getTicketInfo(uint256 tokenId) external view returns (TicketInfo memory) {
        return _requireTicket(tokenId);
    }

    function getAvailableTickets(uint256 eventId) external view returns (uint256[] memory) {
        _requireEvent(eventId);
        return _availablePoolByEvent[eventId];
    }

    function getWalletTickets(
        uint256 eventId,
        address wallet
    ) external view returns (uint256[] memory) {
        _requireEvent(eventId);
        uint256 count = _walletTicketCount[eventId][wallet];
        uint256[] memory result = new uint256[](count);
        uint256 found;

        for (uint256 tokenId = 0; tokenId < _nextTokenId && found < count; tokenId++) {
            TicketInfo storage ticket = _tickets[tokenId];
            if (
                ticket.eventId == eventId &&
                ticket.owner == wallet &&
                (ticket.status == TicketStatus.SOLD ||
                    ticket.status == TicketStatus.FROZEN ||
                    ticket.status == TicketStatus.USED)
            ) {
                result[found++] = tokenId;
            }
        }
        return result;
    }

    function walletTicketCount(
        uint256 eventId,
        address wallet
    ) external view returns (uint256) {
        _requireEvent(eventId);
        return _walletTicketCount[eventId][wallet];
    }

    function isStaff(address account) external view returns (bool) {
        return _isStaff[account];
    }

    function _buyTicket(
        uint256 eventId,
        uint256 tokenId,
        address buyer,
        EventInfo storage eventInfo
    ) private {
        TicketInfo storage ticket = _requireTicket(tokenId);
        require(ticket.eventId == eventId, "TrustTix: ticket belongs to another event");
        require(ticket.status == TicketStatus.AVAILABLE, "TrustTix: ticket not available");
        require(_inPool[eventId][tokenId], "TrustTix: ticket not in pool");
        require(
            _walletTicketCount[eventId][buyer] <
                eventInfo.maxTicketsPerWallet,
            "TrustTix: wallet ticket limit reached"
        );

        _removeFromPool(eventId, tokenId);
        ticket.status = TicketStatus.SOLD;
        ticket.owner = buyer;
        ticket.pricePaid = eventInfo.ticketPrice;
        ticket.purchaseTime = block.timestamp;
        _walletTicketCount[eventId][buyer]++;
        eventInfo.ticketsSold++;
        eventInfo.ticketsAvailable--;

        _transfer(address(this), buyer, tokenId);
        emit TicketPurchased(
            eventId,
            tokenId,
            buyer,
            ticket.seatNumber,
            eventInfo.ticketPrice,
            block.timestamp
        );
    }

    function _removeFromPool(uint256 eventId, uint256 tokenId) private {
        uint256[] storage pool = _availablePoolByEvent[eventId];
        uint256 length = pool.length;
        for (uint256 i = 0; i < length; i++) {
            if (pool[i] == tokenId) {
                pool[i] = pool[length - 1];
                pool.pop();
                _inPool[eventId][tokenId] = false;
                return;
            }
        }
        revert("TrustTix: ticket not in pool");
    }

    function _requireEvent(uint256 eventId) private view {
        require(eventId > 0 && eventId < _nextEventId, "TrustTix: event does not exist");
    }

    function _requireActiveEvent(
        uint256 eventId
    ) private view returns (EventInfo storage eventInfo) {
        _requireEvent(eventId);
        eventInfo = _events[eventId];
        require(eventInfo.active, "TrustTix: event is inactive");
    }

    function _requireTicket(
        uint256 tokenId
    ) private view returns (TicketInfo storage ticket) {
        ticket = _tickets[tokenId];
        require(ticket.eventId != 0, "TrustTix: ticket does not exist");
    }

    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0) && from != address(this)) {
            TicketInfo storage ticket = _tickets[tokenId];
            require(ticket.status != TicketStatus.FROZEN, "TrustTix: frozen tickets cannot be transferred");
            require(ticket.status != TicketStatus.USED, "TrustTix: used tickets cannot be transferred");
            require(
                _walletTicketCount[ticket.eventId][to] <
                    _events[ticket.eventId].maxTicketsPerWallet,
                "TrustTix: recipient event ticket limit reached"
            );
            _walletTicketCount[ticket.eventId][from]--;
            _walletTicketCount[ticket.eventId][to]++;
            ticket.owner = to;
        }
        return super._update(to, tokenId, auth);
    }

    receive() external payable {}
}
