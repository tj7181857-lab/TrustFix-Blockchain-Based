import React from "react";

export default function WalletBar({ wallet }) {
  const { account, chainId, isCorrectNetwork, isConnecting, error, connect, disconnect, addHardhatNetwork, role } = wallet;
  const shortAddress = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;

  return (
    <div className="wallet-control">
      {error && <span className="wallet-error" role="alert">{error}</span>}
      {account ? <>
        <span className={`network-chip ${isCorrectNetwork ? "network-ok" : "network-bad"}`}>
          <i />{isCorrectNetwork ? "Hardhat Local" : `Chain ${chainId ?? "unknown"}`}
        </span>
        {!isCorrectNetwork && <button className="text-button wallet-switch" onClick={addHardhatNetwork}>Switch</button>}
        <span className="role-chip">{role}</span>
        <span className="wallet-address" title={account}>{shortAddress(account)}</span>
        <button className="button button-secondary button-small" onClick={disconnect}>Disconnect</button>
      </> : <button className="button button-primary button-small" onClick={connect} disabled={isConnecting}>{isConnecting ? "Connecting…" : "Connect wallet"}</button>}
    </div>
  );
}
