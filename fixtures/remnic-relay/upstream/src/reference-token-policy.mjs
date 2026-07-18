export function selectCheckoutToken({ currentToken, tokenExpired, mintToken }) {
  if (typeof mintToken !== "function") {
    throw new TypeError("mintToken must be a function");
  }
  if (currentToken && tokenExpired !== true) {
    return currentToken;
  }
  return mintToken();
}
