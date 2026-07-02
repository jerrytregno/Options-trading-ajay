window.APP_CONFIG = {
  firebase: {
    apiKey: "AIzaSyA_W-5CfqZjVcjfX8RXmYXOoRjQb1hxuf0",
    authDomain: "options-trading-85942.firebaseapp.com",
    projectId: "options-trading-85942",
    storageBucket: "options-trading-85942.firebasestorage.app",
    messagingSenderId: "656483826770",
    appId: "1:656483826770:web:72581638f3789fba8f338b",
  },
  watchlist: [
    { id: "nifty", label: "Nifty 50", segment: "index", kiteKey: "NSE:NIFTY 50" },
    { id: "banknifty", label: "Bank Nifty", segment: "index", kiteKey: "NSE:NIFTY BANK" },
    { id: "reliance", label: "Reliance", segment: "equity", kiteKey: "NSE:RELIANCE" },
    { id: "tcs", label: "TCS", segment: "equity", kiteKey: "NSE:TCS" },
    { id: "infy", label: "Infosys", segment: "equity", kiteKey: "NSE:INFY" },
    { id: "gold", label: "Gold", segment: "commodity", kiteKey: "GOLDM", resolveMcx: true },
    { id: "silver", label: "Silver", segment: "commodity", kiteKey: "SILVERM", resolveMcx: true },
    { id: "crude", label: "Crude Oil", segment: "commodity", kiteKey: "CRUDEOIL", resolveMcx: true },
    { id: "naturalgas", label: "Natural Gas", segment: "commodity", kiteKey: "NATURALGAS", resolveMcx: true },
  ],
  underlyings: [
    { symbol: "NIFTY", exchange: "NFO", label: "Nifty 50" },
    { symbol: "BANKNIFTY", exchange: "NFO", label: "Bank Nifty" },
    { symbol: "FINNIFTY", exchange: "NFO", label: "Fin Nifty" },
    { symbol: "SENSEX", exchange: "BFO", label: "Sensex" },
    { symbol: "RELIANCE", exchange: "NFO", label: "Reliance" },
    { symbol: "TCS", exchange: "NFO", label: "TCS" },
  ],
};
