// A small, local enhancement: the walkthrough remains readable with the first
// step visible when JavaScript is unavailable. No analytics or network calls.
const tabs = [...document.querySelectorAll('[role="tab"][data-step]')];
const panels = [...document.querySelectorAll('[role="tabpanel"][data-step-panel]')];
const flowPoints = [...document.querySelectorAll('.flow-point')];

const artwork = document.querySelector('.hero-art-sculpture');
if (artwork) {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  let lightFrame = null;
  let pointer;
  const dimArtwork = () => {
    if (lightFrame !== null) cancelAnimationFrame(lightFrame);
    lightFrame = null;
    artwork.classList.remove('is-lit');
  };
  const followLight = (event) => {
    if (!finePointer.matches || event.pointerType === 'touch') return;
    pointer = { x: event.clientX, y: event.clientY };
    if (lightFrame !== null) return;
    lightFrame = requestAnimationFrame(() => {
      lightFrame = null;
      const bounds = artwork.getBoundingClientRect();
      artwork.style.setProperty('--light-x', `${pointer.x - bounds.left}px`);
      artwork.style.setProperty('--light-y', `${pointer.y - bounds.top}px`);
      artwork.classList.add('is-lit');
    });
  };
  artwork.addEventListener('pointerenter', followLight);
  artwork.addEventListener('pointermove', followLight);
  artwork.addEventListener('pointerleave', dimArtwork);
  artwork.addEventListener('pointercancel', dimArtwork);
  window.addEventListener('blur', dimArtwork);
  reducedMotion.addEventListener('change', dimArtwork);
  finePointer.addEventListener('change', dimArtwork);
}

for (const menu of document.querySelectorAll('.tools-menu')) {
  document.addEventListener('pointerdown', (event) => {
    if (!menu.contains(event.target)) menu.open = false;
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.open) {
      menu.open = false;
      menu.querySelector('summary').focus();
    }
  });
}

for (const switcher of document.querySelectorAll('[data-install-switcher]')) {
  const choices = [...switcher.querySelectorAll('[data-install-platform]')];
  const select = (index, focus = false) => {
    choices.forEach((button, position) => {
      const active = position === index;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      document.getElementById(button.getAttribute('aria-controls')).hidden = !active;
    });
    const download = switcher.closest('article')?.querySelector('[data-install-download]');
    if (download) {
      const platform = choices[index].dataset.installPlatform;
      download.href = { linux: '/install.sh', macos: '/install-desktop.sh', windows: '/install.ps1' }[platform];
      download.textContent = `Download the ${choices[index].textContent} installer`;
    }
    if (focus) choices[index].focus();
  };
  choices.forEach((button, index) => {
    button.addEventListener('click', () => select(index));
    button.addEventListener('keydown', (event) => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % choices.length;
      else if (event.key === 'ArrowLeft') next = (index - 1 + choices.length) % choices.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = choices.length - 1;
      else return;
      event.preventDefault();
      select(next, true);
    });
  });
}

function selectStep(index, focus = false) {
  if (index < 0 || index >= tabs.length) return;
  const step = tabs[index].dataset.step;
  tabs.forEach((tab, position) => {
    const selected = position === index;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  panels.forEach((panel) => { panel.hidden = panel.dataset.stepPanel !== step; });
  flowPoints.forEach((point, position) => point.classList.toggle('is-active', position <= index));
  if (focus) tabs[index].focus();
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectStep(index));
  tab.addEventListener('keydown', (event) => {
    let next = index;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    selectStep(next, true);
  });
});

for (const button of document.querySelectorAll('[data-copy-command]')) {
  button.addEventListener('click', async () => {
    const command = document.getElementById(button.dataset.copyCommand);
    const feedback = button.closest('.setup-command')?.querySelector('.copy-feedback');
    if (!command || !feedback) return;
    const value = command.textContent.trim();
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      feedback.textContent = 'Commands copied.';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(command);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      command.focus();
      feedback.textContent = 'Commands selected. Press Ctrl+C (or ⌘C) to copy.';
    }
  });
}
