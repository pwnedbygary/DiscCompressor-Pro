import { CompressionSettings, Theme } from './types';

export const DEFAULT_SETTINGS: CompressionSettings = {
  hunkSize: 4096,
  chdAlgorithms: ['zlib'],
  compressionLevel: 9,
  threads: 4,
};

export const CHD_ALGORITHMS = [
  { id: 'zlib', name: 'Zlib' },
  { id: 'lzma', name: 'LZMA' },
  { id: 'huffman', name: 'Huffman' },
  { id: 'flac', name: 'FLAC' },
];

export const HUNK_SIZES = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];

export const THEMES: Theme[] = [
  {
    name: 'Adwaita (Default)',
    id: 'adwaita',
    colors: {
      bg: '#f6f5f4',
      sidebar: '#ebebeb',
      header: '#ffffff',
      text: '#2e3436',
      muted: '#888a85',
      accent: '#3584e4',
      accentText: '#ffffff',
      border: '#dcdcdc',
      success: '#2ec27e',
      error: '#e01b24',
      warning: '#f5c211',
      info: '#1c71d8',
    },
  },
  {
    name: 'Gruvbox',
    id: 'gruvbox',
    colors: {
      bg: '#282828',
      sidebar: '#1d2021',
      header: '#3c3836',
      text: '#ebdbb2',
      muted: '#928374',
      accent: '#d79921',
      accentText: '#282828',
      border: '#504945',
      success: '#b8bb26',
      error: '#fb4934',
      warning: '#fabd2f',
      info: '#83a598',
    },
  },
  {
    name: 'Nord',
    id: 'nord',
    colors: {
      bg: '#2e3440',
      sidebar: '#3b4252',
      header: '#434c5e',
      text: '#eceff4',
      muted: '#d8dee9',
      accent: '#88c0d0',
      accentText: '#2e3440',
      border: '#4c566a',
      success: '#a3be8c',
      error: '#bf616a',
      warning: '#ebcb8b',
      info: '#81a1c1',
    },
  },
  {
    name: 'Solarized Dark',
    id: 'solarized',
    colors: {
      bg: '#002b36',
      sidebar: '#073642',
      header: '#073642',
      text: '#839496',
      muted: '#586e75',
      accent: '#268bd2',
      accentText: '#fdf6e3',
      border: '#586e75',
      success: '#859900',
      error: '#dc322f',
      warning: '#b58900',
      info: '#2aa198',
    },
  },
  {
    name: 'Monokai',
    id: 'monokai',
    colors: {
      bg: '#272822',
      sidebar: '#1e1f1c',
      header: '#3e3d32',
      text: '#f8f8f2',
      muted: '#75715e',
      accent: '#a6e22e',
      accentText: '#272822',
      border: '#49483e',
      success: '#a6e22e',
      error: '#f92672',
      warning: '#e6db74',
      info: '#66d9ef',
    },
  },
];
