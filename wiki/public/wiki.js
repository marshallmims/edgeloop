const input = document.querySelector('#q');
const panel = document.querySelector('#results');
const toggle = document.querySelector('.nav-toggle');
let index = [];
let active = -1;

fetch('/search.json')
    .then((response) => response.json())
    .then((data) => { index = data; })
    .catch(() => { index = []; });

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function hideResults() {
    panel.hidden = true;
    panel.innerHTML = '';
    active = -1;
}

function renderResults(items, empty) {
    if (empty) {
        panel.innerHTML = '<p class="hit-empty">Nothing on the wiki matches that.</p>';
        panel.hidden = false;
        return;
    }
    panel.innerHTML = items.map((item) => (
        `<a role="option" href="${escapeHtml(item.href)}"><span class="hit-page">${escapeHtml(item.page)}</span><span class="hit-heading">${escapeHtml(item.heading)}</span></a>`
    )).join('');
    panel.hidden = false;
    active = -1;
}

function search(query) {
    const q = query.trim().toLowerCase();
    if (q.length < 2) {
        hideResults();
        return;
    }
    const hits = index.filter((item) => item.text.includes(q) || item.heading.toLowerCase().includes(q)).slice(0, 8);
    renderResults(hits, hits.length === 0);
}

input?.addEventListener('input', () => search(input.value));

input?.addEventListener('keydown', (event) => {
    const options = [...panel.querySelectorAll('a')];
    if (event.key === 'Escape') {
        hideResults();
        return;
    }
    if (!options.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        active = event.key === 'ArrowDown'
            ? Math.min(options.length - 1, active + 1)
            : Math.max(0, active - 1);
        options.forEach((option, i) => option.setAttribute('aria-selected', i === active ? 'true' : 'false'));
        options[active].scrollIntoView({ block: 'nearest' });
    }
    if (event.key === 'Enter' && active >= 0) {
        event.preventDefault();
        options[active].click();
    }
});

document.addEventListener('click', (event) => {
    if (!event.target.closest('.search')) hideResults();
});

document.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement !== input && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        input?.focus();
    }
    if (event.key === 'Escape') {
        document.body.classList.remove('nav-open');
        toggle?.setAttribute('aria-expanded', 'false');
    }
});

toggle?.addEventListener('click', () => {
    const open = document.body.classList.toggle('nav-open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
});

const toc = document.querySelector('.toc details');
if (toc && window.matchMedia('(min-width: 1101px)').matches) toc.open = true;

document.querySelectorAll('#site-nav a').forEach((link) => {
    link.addEventListener('click', () => {
        document.body.classList.remove('nav-open');
        toggle?.setAttribute('aria-expanded', 'false');
    });
});
