import { lazy, Suspense, useEffect, useState } from "react";

// three.js is large, so the lanyard only loads on the page that shows it.
const Lanyard = lazy(() => import("./reactbits/Lanyard"));

const W = 1024;
const H = 1440;

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function fit(ctx: CanvasRenderingContext2D, text: string, max: number, size: number, font: string) {
  let px = size;
  ctx.font = `${px}px ${font}`;
  while (px > 40 && ctx.measureText(text).width > max) ctx.font = `${(px -= 4)}px ${font}`;
}

/** Paints the badge face in the site's paper, espresso and bronze. */
async function paintFace(name: string, access: string, memberId: number) {
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#f7f4f0";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#241006";
  ctx.fillRect(0, 0, W, 120);
  ctx.fillStyle = "#f7961d";
  ctx.fillRect(0, 120, W, 10);
  try {
    const logo = await loadImage("/assets/collaboratory-logo.webp");
    const lw = 760;
    ctx.drawImage(logo, (W - lw) / 2, 200, lw, (lw * logo.height) / logo.width);
  } catch {
    // The badge still reads without the logo.
  }
  ctx.textAlign = "center";
  ctx.fillStyle = "#a86008";
  ctx.font = "700 44px Barlow";
  ctx.fillText("MEMBER", W / 2, 760);
  ctx.fillStyle = "#24150e";
  fit(ctx, name, W - 140, 112, "'Black Ops One'");
  ctx.fillText(name, W / 2, 890);
  ctx.fillStyle = "#685d57";
  ctx.font = "600 56px Barlow";
  ctx.fillText(access, W / 2, 990);
  ctx.fillStyle = "#241006";
  ctx.fillRect(0, H - 250, W, 250);
  ctx.fillStyle = "#e0d1c9";
  ctx.font = "600 46px Barlow";
  ctx.fillText(`ID ${String(memberId).padStart(6, "0")}`, W / 2, H - 110);
  return canvas.toDataURL("image/png");
}

function paintStrap() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 1024;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#f7961d";
  ctx.fillRect(0, 0, 128, 1024);
  ctx.fillStyle = "#241006";
  ctx.translate(64, 512);
  ctx.rotate(Math.PI / 2);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "56px 'Black Ops One'";
  ctx.fillText("COLLABORATORY", 0, 0);
  return canvas.toDataURL("image/png");
}

export function MemberBadge({
  name,
  access,
  memberId,
}: {
  name: string;
  access: string;
  memberId: number;
}) {
  const [face, setFace] = useState<string>();
  const [strap, setStrap] = useState<string>();
  useEffect(() => {
    let live = true;
    void paintFace(name, access, memberId).then((url) => live && setFace(url));
    void document.fonts.ready.then(() => live && setStrap(paintStrap()));
    return () => {
      live = false;
    };
  }, [name, access, memberId]);
  return (
    <div className="member-badge" role="img" aria-label={`Member badge for ${name}: ${access}`}>
      {face ? (
        <Suspense fallback={null}>
          <Lanyard
            frontImage={face}
            backImage={face}
            strapImage={strap}
            strapColor="#f7961d"
            cardColor="#f7f4f0"
            finish="matte"
            metal="silver"
            size={0.62}
            strapLength={0.42}
            breeze={0.3}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
