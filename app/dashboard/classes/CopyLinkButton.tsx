'use client';

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

export default function CopyLinkButton({
  classId,
  token,
}: {
  classId: string;
  token?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const base = `${window.location.origin}/manual-attendance/${classId}`;
    const url = token ? `${base}?token=${encodeURIComponent(token)}` : base;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title="Copy unique manual register link to share with class teacher via WhatsApp or Email"
      className="h-8 px-3 rounded-[9px] bg-[#f7f7f9] hover:bg-[#efeff2] border border-[#e1e1e5] text-xs font-medium text-[#171719] flex items-center gap-1.5 transition cursor-pointer shadow-2xs"
    >
      {copied ? (
        <>
          <Check className="w-3.5 h-3.5 text-[#30b357]" />
          <span className="text-[#2da94f] font-semibold">Copied Link!</span>
        </>
      ) : (
        <>
          <Copy className="w-3.5 h-3.5 text-[#5e5e63]" />
          <span>Copy Teacher Link</span>
        </>
      )}
    </button>
  );
}
