'use strict';

const input = document.getElementById('q');
const hint = document.getElementById('hint');
const HINT = 'Enter open · Esc close';
let errorTimer = null;

function focusInput(value, command) {
  input.value = value || '';
  input.focus();
  if (command) {
    const end = input.value.length;
    input.setSelectionRange(end, end);
  } else {
    input.select();
  }
}

function showError(message) {
  hint.textContent = message;
  hint.classList.add('error');
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    hint.textContent = HINT;
    hint.classList.remove('error');
  }, 4000);
}

window.tb.onEdit(focusInput);
window.tb.onError(showError);

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    const value = input.value.trim();
    if (value) window.tb.submit(value);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    window.tb.hide();
  }
});
