/** The AWS console's host for a region's partition. GovCloud signs in at one host for both of its regions; ?region= picks one. */
export function consoleHost(region: string): string {
  if (region.startsWith("us-gov-")) return "console.amazonaws-us-gov.com";
  return `${region}.${region.startsWith("cn-") ? "console.amazonaws.cn" : "console.aws.amazon.com"}`;
}
