/** The same immutable signed document is used for profile downloads and email attachments. */
export function signedWaiverCopyContent(copy: {
  waiverName: string; waiverVersion: string; signature: string; signedAt: string;
  waiverText: string; completedWaiverText?: string;
}): string {
  return [
    'SIGNED WAIVER COPY', `Waiver: ${copy.waiverName}`, `Version: ${copy.waiverVersion}`,
    `Signed by: ${copy.signature}`, `Signed at: ${copy.signedAt}`, '',
    'Accepted policy text:', copy.completedWaiverText ?? copy.waiverText, '',
    'This copy reproduces the text and electronic agreement recorded when signed. It does not certify current access eligibility.',
  ].join('\n');
}
