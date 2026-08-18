'use client';

import React, { useState } from 'react';
import { Link2, Check } from 'lucide-react';

export default function CopyLinkButton({ classId }: { classId: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const url = `${window.location.origin}/manual-attendance/${classId}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      title="Copy Attendance Link for Teachers"
      className="inline-flex items-center justify-center w-8 h-8 rounded hover:bg-meridian-gold/10 text-meridian-text-3 hover:text-meridian-gold transition-colors"
    >
      {copied ? <Check className="w-4 h-4 text-green-500" /> : <Link2 className="w-4 h-4" />}
    </button>
  );
}
