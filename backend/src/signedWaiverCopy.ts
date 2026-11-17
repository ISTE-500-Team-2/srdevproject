/**
 * Use the recorded signer and waiver title, even after either account or policy is edited.
 * The recorded signing date keeps a renewal of the same waiver from reusing the earlier copy's name.
 */
export function signedWaiverFileName(signature: string, waiverName: string, signedAt: string): string {
  const part = (value: string, fallback: string) => {
    const safe = value.normalize('NFC').replace(/[^\p{L}\p{M}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '');
    // Bound the whole filename below common filesystem byte limits without splitting Unicode.
    let result = '';
    for (const character of safe) {
      if (Buffer.byteLength(result + character, 'utf8') > 100) break;
      result += character;
    }
    return result || fallback;
  };
  const signer = signature.replace(/\s*\(electronic agreement\)\s*$/i, '')
    .replace(/(^|\s|_|-)\p{L}/gu, initial => initial.toUpperCase());
  const date = /^\d{4}-\d{2}-\d{2}/.exec(signedAt)?.[0];
  return `SIGNED_${part(signer, 'Member')}_${part(waiverName, 'Signed_Waiver')}${date ? `_${date}` : ''}.txt`;
}

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
