import {useEffect, useState} from 'react';
import QRCode from 'qrcode';

interface QrCodeProps {
  value: string;
  size?: number;
}

export function QrCode({value, size = 160}: QrCodeProps) {
  const [svgMarkup, setSvgMarkup] = useState<string>('');

  useEffect(() => {
    let active = true;
    if (!value) return;

    QRCode.toString(value, {
      type: 'svg',
      margin: 1,
      width: size,
      color: {
        dark: '#09090B',
        light: '#FFFFFF',
      },
    })
      .then((svg) => {
        if (active) setSvgMarkup(svg);
      })
      .catch(() => {
        if (active) setSvgMarkup('');
      });

    return () => {
      active = false;
    };
  }, [value, size]);

  if (!svgMarkup) {
    return (
      <div
        style={{width: size, height: size}}
        className="rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900"
      />
    );
  }

  return (
    <div
      style={{width: size, height: size}}
      className="overflow-hidden rounded-lg border border-zinc-200 bg-white p-1.5 dark:border-zinc-700 [&>svg]:h-full [&>svg]:w-full"
      dangerouslySetInnerHTML={{__html: svgMarkup}}
      aria-label="Room connection QR code"
    />
  );
}
