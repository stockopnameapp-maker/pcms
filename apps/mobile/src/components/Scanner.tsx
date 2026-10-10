import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { X } from 'lucide-react';

/**
 * Full-screen QR scanner using the phone's rear camera (getUserMedia; Android asks for the camera permission
 * the first time). Reads Palmora employee/patient cards (PCMS:EMPLOYEE:…, PCMS:PATIENT:…) and plain codes.
 */
export function Scanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    let done = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const tick = () => {
          if (done) return;
          if (v.readyState >= 2 && v.videoWidth && ctx) {
            const w = Math.min(800, v.videoWidth), h = Math.round(v.videoHeight * (w / v.videoWidth));
            canvas.width = w; canvas.height = h;
            ctx.drawImage(v, 0, 0, w, h);
            const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
            if (code?.data) {
              done = true;
              try { navigator.vibrate?.(60); } catch { /* no vibration */ }
              onResult(code.data.trim());
              return;
            }
          }
          timer = window.setTimeout(tick, 180);
        };
        tick();
      } catch (e: any) {
        setErr(e?.name === 'NotAllowedError'
          ? 'Izin kamera ditolak. Buka Pengaturan HP → Aplikasi → Palmora Health → Izin, lalu izinkan Kamera.'
          : 'Kamera tidak dapat dibuka di perangkat ini.');
      }
    })();
    return () => { done = true; window.clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, [onResult]);

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col" role="dialog" aria-modal="true" aria-label="Pindai QR">
      <div className="safe-top" />
      <div className="flex items-center justify-between px-4 h-14 text-white">
        <p className="font-medium">Pindai kartu QR karyawan / pasien</p>
        <button className="w-11 h-11 grid place-items-center rounded-full active:bg-white/15" aria-label="Tutup pemindai" onClick={onClose}><X className="w-6 h-6" /></button>
      </div>
      <div className="relative flex-1 overflow-hidden">
        <video ref={video} className="absolute inset-0 w-full h-full object-cover" playsInline muted />
        <div className="absolute inset-0 grid place-items-center pointer-events-none">
          <div className="w-64 h-64 rounded-3xl border-4 border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,.45)]" />
        </div>
        {err && <p className="absolute left-4 right-4 bottom-8 rounded-xl bg-white text-ink p-4 text-[14.5px]">{err}</p>}
      </div>
      <p className="text-center text-white/80 text-[14px] py-5 safe-bottom">Arahkan kamera ke kode QR pada kartu</p>
    </div>
  );
}
