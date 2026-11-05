"use client";
import { useEffect, useState } from "react";
import QRCode from "qrcode";

export default function QR({ text, size = 180 }: { text: string; size?: number }) {
  const [src, setSrc] = useState<string>("");
  useEffect(() => {
    QRCode.toDataURL(text, {
      width: size,
      margin: 1,
      color: { dark: "#0a0a12", light: "#ffffff" },
    })
      .then(setSrc)
      .catch(() => setSrc(""));
  }, [text, size]);
  if (!src)
    return (
      <div
        style={{ width: size, height: size }}
        className="rounded-xl bg-[var(--card-2)]"
      />
    );
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt="QR code"
      className="rounded-xl bg-white p-2"
    />
  );
}
