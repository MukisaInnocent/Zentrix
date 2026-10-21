// Progressive motion: scroll reveal, number count-up and a header shadow on scroll. Without JavaScript,
// or with reduced motion, every element is simply shown in its final state.
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function countUp(el) {
  const target = Number(el.dataset.count);
  if (!Number.isFinite(target)) return;
  const decimals = Number(el.dataset.decimals ?? 0);
  const suffix = el.dataset.suffix ?? '';
  const render = n => `${n.toFixed(decimals)}${suffix}`;
  if (reduced()) return void (el.textContent = render(target));
  const start = performance.now();
  const duration = 1100;
  const tick = now => {
    const p = Math.min(1, (now - start) / duration);
    el.textContent = render(target * (1 - (1 - p) ** 3));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function initMotion() {
  document.documentElement.classList.add('zx-js');
  const targets = [...document.querySelectorAll('[data-reveal], [data-count]')];
  if (targets.length && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('zx-in');
        if (entry.target.dataset.count !== undefined) countUp(entry.target);
        io.unobserve(entry.target);
      }
    }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
    targets.forEach((el, i) => {
      if (el.dataset.reveal !== undefined && !el.style.getPropertyValue('--zx-delay')) el.style.setProperty('--zx-delay', `${(i % 4) * 70}ms`);
      io.observe(el);
    });
  } else {
    targets.forEach(el => el.classList.add('zx-in'));
  }
  const header = document.querySelector('.zx-public-header');
  if (header) {
    const onScroll = () => header.classList.toggle('zx-is-scrolled', window.scrollY > 8);
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
}
