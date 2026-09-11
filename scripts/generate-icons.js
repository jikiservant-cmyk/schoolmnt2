const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// SVG Icon Template with high-res biometric fingerprint + smart school cap + sleek gradient
const svgIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0b0e14"/>
      <stop offset="50%" stop-color="#111827"/>
      <stop offset="100%" stop-color="#070a0f"/>
    </linearGradient>
    <linearGradient id="primaryGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#00c6ff"/>
      <stop offset="50%" stop-color="#0072ff"/>
      <stop offset="100%" stop-color="#0051cc"/>
    </linearGradient>
    <linearGradient id="glowGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0072ff" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#00c6ff" stop-opacity="0"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="12" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>
  </defs>

  <!-- Background rounded squircle -->
  <rect width="512" height="512" rx="115" fill="url(#bgGrad)"/>
  
  <!-- Subtle inner border -->
  <rect x="6" y="6" width="500" height="500" rx="110" fill="none" stroke="#2a3854" stroke-width="3" stroke-opacity="0.4"/>

  <!-- Ambient Glow -->
  <circle cx="256" cy="256" r="180" fill="url(#glowGrad)"/>

  <!-- Biometric Fingerprint / Waves + Academic Crest Vector -->
  <g transform="translate(256, 256)" filter="url(#glow)">
    
    <!-- Central Shield / Badge Backing -->
    <path d="M 0 -130 L 110 -75 C 110 50 60 125 0 155 C -60 125 -110 50 -110 -75 Z" 
          fill="none" 
          stroke="url(#primaryGrad)" 
          stroke-width="12" 
          stroke-linejoin="round"
          stroke-linecap="round"/>

    <!-- Inner Core Cap / Graduation Element -->
    <path d="M 0 -55 L 70 -20 L 0 15 L -70 -20 Z" fill="url(#primaryGrad)"/>
    <path d="M -45 -6 L -45 35 C -45 52 45 52 45 35 L 45 -6" fill="none" stroke="url(#primaryGrad)" stroke-width="9" stroke-linecap="round"/>
    
    <!-- Tassel / Smart Signal dot -->
    <circle cx="70" cy="-20" r="6" fill="#ffffff"/>
    <path d="M 70 -20 Q 85 10 75 35" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round"/>
    <circle cx="75" cy="40" r="7" fill="#00c6ff"/>

    <!-- Biometric Arcs below -->
    <path d="M -50 70 C -25 90 25 90 50 70" fill="none" stroke="url(#primaryGrad)" stroke-width="9" stroke-linecap="round"/>
    <path d="M -30 100 C -15 112 15 112 30 100" fill="none" stroke="#00c6ff" stroke-width="8" stroke-linecap="round"/>
  </g>
</svg>`;

async function run() {
  const publicDir = path.join(__dirname, '..', 'public');
  const svgBuffer = Buffer.from(svgIcon);

  // Save SVG
  fs.writeFileSync(path.join(publicDir, 'app-icon.svg'), svgIcon);

  // Generate 192x192
  await sharp(svgBuffer)
    .resize(192, 192)
    .png()
    .toFile(path.join(publicDir, 'icon-192x192.png'));

  // Generate 512x512
  await sharp(svgBuffer)
    .resize(512, 512)
    .png()
    .toFile(path.join(publicDir, 'icon-512x512.png'));

  // Generate maskable (192 and 512 with safe area)
  await sharp(svgBuffer)
    .resize(512, 512)
    .png()
    .toFile(path.join(publicDir, 'icon-maskable.png'));

  // Generate Apple Touch Icon 180x180
  await sharp(svgBuffer)
    .resize(180, 180)
    .png()
    .toFile(path.join(publicDir, 'apple-touch-icon.png'));

  // Generate Favicon 48x48 PNG
  await sharp(svgBuffer)
    .resize(48, 48)
    .png()
    .toFile(path.join(publicDir, 'favicon.png'));

  console.log('PWA Icons generated successfully in /public!');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
