// ===== CURSEUR PERSONNALISÉ =====
(function() {
  const cursor = document.createElement('div');
  cursor.className = 'custom-cursor';
  cursor.innerHTML = `
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">
      <rect x="9" y="9" width="14" height="14" fill="var(--accent)" fill-opacity="0.333" stroke="none" style="transition:x 0.18s, y 0.18s, width 0.18s, height 0.18s"></rect>
      <rect x="13" y="13" width="6" height="6" fill="var(--accent)"></rect>
    </svg>
  `;
  document.body.appendChild(cursor);

  let mouseX = 0, mouseY = 0;
  let cursorX = 0, cursorY = 0;

  document.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  });

  // Animation fluide avec requestAnimationFrame
  function animate() {
    cursorX += (mouseX - cursorX) * 0.5; // Lissage
    cursorY += (mouseY - cursorY) * 0.5;
    
    cursor.style.transform = `translate(${cursorX}px, ${cursorY}px)`;
    requestAnimationFrame(animate);
  }
  animate();

  // Animation au clic (petit effet)
  document.addEventListener('mousedown', () => {
    cursor.style.filter = 'brightness(1.5)';
  });
  document.addEventListener('mouseup', () => {
    cursor.style.filter = 'brightness(1)';
  });
})();