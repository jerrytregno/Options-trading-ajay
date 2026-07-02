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
    { id: "nifty", label: "Nifty 50", segment: "index", kiteKey: "NSE:NIFTY 50", tradingViewSymbol: "NSE:NIFTY" },
    { id: "banknifty", label: "Bank Nifty", segment: "index", kiteKey: "NSE:NIFTY BANK", tradingViewSymbol: "NSE:BANKNIFTY" },
    { id: "reliance", label: "Reliance", segment: "equity", kiteKey: "NSE:RELIANCE", tradingViewSymbol: "NSE:RELIANCE" },
    { id: "tcs", label: "TCS", segment: "equity", kiteKey: "NSE:TCS", tradingViewSymbol: "NSE:TCS" },
    { id: "infy", label: "Infosys", segment: "equity", kiteKey: "NSE:INFY", tradingViewSymbol: "NSE:INFY" },
    { id: "gold", label: "Gold", segment: "commodity", kiteKey: "GOLDM", tradingViewSymbol: "MCX:GOLD1!", resolveMcx: true },
    { id: "silver", label: "Silver", segment: "commodity", kiteKey: "SILVERM", tradingViewSymbol: "MCX:SILVER1!", resolveMcx: true },
    { id: "crude", label: "Crude Oil", segment: "commodity", kiteKey: "CRUDEOIL", tradingViewSymbol: "MCX:CRUDEOIL1!", resolveMcx: true },
    { id: "naturalgas", label: "Natural Gas", segment: "commodity", kiteKey: "NATURALGAS", tradingViewSymbol: "MCX:NATURALGAS1!", resolveMcx: true },
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
