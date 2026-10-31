export const buildProductUrl = (storeDomain, alias) => {
  if (!storeDomain || !alias) return "";
  return `https://${storeDomain}/${alias}`;
};
