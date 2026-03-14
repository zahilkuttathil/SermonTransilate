/**
 * langPicker.js
 *
 * Renders and manages the translation language selector dropdown.
 * Selection is persisted in localStorage so the user's choice survives refreshes.
 *
 * Emits via eventBus:
 *   'lang:changed' — { code: string, label: string }
 */

import { eventBus } from '../utils/eventBus.js';

const STORAGE_KEY = 'preachlisten:targetLang';

/** Azure Translator-supported languages shown in the picker */
const LANGUAGES = [
  { code: 'af',      label: 'Afrikaans' },
  { code: 'ar',      label: 'Arabic (العربية)' },
  { code: 'bn',      label: 'Bengali (বাংলা)' },
  { code: 'bs',      label: 'Bosnian' },
  { code: 'bg',      label: 'Bulgarian' },
  { code: 'yue',     label: 'Cantonese (粵語)' },
  { code: 'ca',      label: 'Catalan' },
  { code: 'zh-Hans', label: 'Chinese Simplified (中文)' },
  { code: 'zh-Hant', label: 'Chinese Traditional (繁體)' },
  { code: 'hr',      label: 'Croatian' },
  { code: 'cs',      label: 'Czech' },
  { code: 'da',      label: 'Danish' },
  { code: 'nl',      label: 'Dutch' },
  { code: 'en',      label: 'English' },
  { code: 'et',      label: 'Estonian' },
  { code: 'fi',      label: 'Finnish' },
  { code: 'fr',      label: 'French (Français)' },
  { code: 'de',      label: 'German (Deutsch)' },
  { code: 'el',      label: 'Greek (Ελληνικά)' },
  { code: 'gu',      label: 'Gujarati (ગુજરાતી)' },
  { code: 'ht',      label: 'Haitian Creole' },
  { code: 'he',      label: 'Hebrew (עברית)' },
  { code: 'hi',      label: 'Hindi (हिन्दी)' },
  { code: 'hu',      label: 'Hungarian' },
  { code: 'id',      label: 'Indonesian' },
  { code: 'ga',      label: 'Irish' },
  { code: 'it',      label: 'Italian (Italiano)' },
  { code: 'ja',      label: 'Japanese (日本語)' },
  { code: 'kn',      label: 'Kannada (ಕನ್ನಡ)' },
  { code: 'ko',      label: 'Korean (한국어)' },
  { code: 'lv',      label: 'Latvian' },
  { code: 'lt',      label: 'Lithuanian' },
  { code: 'ms',      label: 'Malay' },
  { code: 'ml',      label: 'Malayalam (മലയാളം)' },
  { code: 'mt',      label: 'Maltese' },
  { code: 'mr',      label: 'Marathi (मराठी)' },
  { code: 'nb',      label: 'Norwegian' },
  { code: 'fa',      label: 'Persian (فارسی)' },
  { code: 'fil',     label: 'Filipino (Tagalog)' },
  { code: 'pl',      label: 'Polish' },
  { code: 'pt',      label: 'Portuguese (Português)' },
  { code: 'ro',      label: 'Romanian' },
  { code: 'ru',      label: 'Russian (Русский)' },
  { code: 'sr-Cyrl', label: 'Serbian (Cyrillic)' },
  { code: 'sk',      label: 'Slovak' },
  { code: 'sl',      label: 'Slovenian' },
  { code: 'es',      label: 'Spanish (Español)' },
  { code: 'sw',      label: 'Swahili (Kiswahili)' },
  { code: 'sv',      label: 'Swedish' },
  { code: 'ta',      label: 'Tamil (தமிழ்)' },
  { code: 'te',      label: 'Telugu (తెలుగు)' },
  { code: 'th',      label: 'Thai (ภาษาไทย)' },
  { code: 'tr',      label: 'Turkish' },
  { code: 'uk',      label: 'Ukrainian (Українська)' },
  { code: 'ur',      label: 'Urdu (اردو)' },
  { code: 'vi',      label: 'Vietnamese (Tiếng Việt)' },
  { code: 'cy',      label: 'Welsh' },
  { code: 'zu',      label: 'Zulu' },
];

let _selectedCode  = null;
let _selectedLabel = null;

/**
 * Initialise the language picker controls.
 * Restores last selection from localStorage.
 */
export function initLangPicker() {
  const btnLang    = document.getElementById('btn-lang');
  const langLabel  = document.getElementById('lang-label');
  const dropdown   = document.getElementById('lang-dropdown');
  const overlay    = document.getElementById('lang-overlay');

  // Build dropdown items
  LANGUAGES.forEach(lang => {
    const item = document.createElement('div');
    item.className    = 'lang-option';
    item.role         = 'option';
    item.dataset.code = lang.code;
    item.textContent  = lang.label;
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-selected', 'false');

    item.addEventListener('click', () => _selectLang(lang.code, lang.label));
    item.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        _selectLang(lang.code, lang.label);
      }
    });

    dropdown.appendChild(item);
  });

  // Restore saved selection (default: English)
  const saved = localStorage.getItem(STORAGE_KEY);
  const savedLang = LANGUAGES.find(l => l.code === saved) ?? LANGUAGES.find(l => l.code === 'en');
  _applySelection(savedLang.code, savedLang.label, langLabel, dropdown);

  // Toggle dropdown open/close
  btnLang.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = dropdown.classList.contains('lang-dropdown--open');
    _toggleDropdown(!isOpen);
  });

  // Close on overlay click (mobile tap-away)
  overlay.addEventListener('click', () => _toggleDropdown(false));

  // Close on Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') _toggleDropdown(false);
  });

  function _toggleDropdown(open) {
    dropdown.classList.toggle('lang-dropdown--hidden', !open);
    dropdown.classList.toggle('lang-dropdown--open',   open);
    overlay.classList.toggle('overlay--hidden', !open);
    btnLang.setAttribute('aria-expanded', String(open));
    if (open) {
      // Scroll selected item into view
      const selected = dropdown.querySelector('[aria-selected="true"]');
      selected?.scrollIntoView({ block: 'nearest' });
      selected?.focus();
    }
  }

  function _selectLang(code, label) {
    _applySelection(code, label, langLabel, dropdown);
    _toggleDropdown(false);
    eventBus.emit('lang:changed', { code, label });
  }
}

function _applySelection(code, label, langLabelEl, dropdown) {
  _selectedCode  = code;
  _selectedLabel = label;

  localStorage.setItem(STORAGE_KEY, code);
  langLabelEl.textContent = label;

  // Update aria-selected on all items
  dropdown.querySelectorAll('.lang-option').forEach(item => {
    const isSelected = item.dataset.code === code;
    item.setAttribute('aria-selected', String(isSelected));
    item.classList.toggle('lang-option--selected', isSelected);
  });
}

/** Get the currently selected language code (e.g. "es"). */
export function getSelectedLangCode() { return _selectedCode; }

/** Get the currently selected language label (e.g. "Spanish (Español)"). */
export function getSelectedLangLabel() { return _selectedLabel; }

/** All supported languages list */
export { LANGUAGES };
