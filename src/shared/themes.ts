export interface ThemeColors {
  bg: string
  surface: string
  elevated: string
  text: string
  muted: string
  accent: string
  accentText: string
  border: string
  success: string
  danger: string
  warning: string
  info: string
}

export interface Theme {
  id: string
  name: string
  dark: boolean
  colors: ThemeColors
}

/** Follows the operating system's light/dark preference. */
export const SYSTEM_THEME_ID = 'system'

// Palettes carried over from v1 (bg/sidebar/header map to bg/surface/elevated).
export const THEMES: readonly Theme[] = [
  {
    id: 'adwaita',
    name: 'Adwaita',
    dark: false,
    colors: {
      bg: '#f6f5f4',
      surface: '#ebebeb',
      elevated: '#ffffff',
      text: '#2e3436',
      muted: '#77767b',
      accent: '#3584e4',
      accentText: '#ffffff',
      border: '#dcdcdc',
      success: '#26a269',
      danger: '#e01b24',
      warning: '#c88800',
      info: '#1c71d8'
    }
  },
  {
    id: 'adwaita-dark',
    name: 'Adwaita Dark',
    dark: true,
    colors: {
      bg: '#242424',
      surface: '#1e1e1e',
      elevated: '#303030',
      text: '#ffffff',
      muted: '#9a9996',
      accent: '#3584e4',
      accentText: '#ffffff',
      border: '#4a4a4a',
      success: '#26a269',
      danger: '#e5484d',
      warning: '#cd9309',
      info: '#62a0ea'
    }
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    dark: true,
    colors: {
      bg: '#282828',
      surface: '#1d2021',
      elevated: '#3c3836',
      text: '#ebdbb2',
      muted: '#928374',
      accent: '#d79921',
      accentText: '#282828',
      border: '#504945',
      success: '#b8bb26',
      danger: '#fb4934',
      warning: '#fabd2f',
      info: '#83a598'
    }
  },
  {
    id: 'nord',
    name: 'Nord',
    dark: true,
    colors: {
      bg: '#2e3440',
      surface: '#3b4252',
      elevated: '#434c5e',
      text: '#eceff4',
      muted: '#a3abbd',
      accent: '#88c0d0',
      accentText: '#2e3440',
      border: '#4c566a',
      success: '#a3be8c',
      danger: '#bf616a',
      warning: '#ebcb8b',
      info: '#81a1c1'
    }
  },
  {
    id: 'solarized',
    name: 'Solarized Dark',
    dark: true,
    colors: {
      bg: '#002b36',
      surface: '#073642',
      elevated: '#073642',
      text: '#93a1a1',
      muted: '#657b83',
      accent: '#268bd2',
      accentText: '#fdf6e3',
      border: '#2c4f57',
      success: '#859900',
      danger: '#dc322f',
      warning: '#b58900',
      info: '#2aa198'
    }
  },
  {
    id: 'monokai',
    name: 'Monokai',
    dark: true,
    colors: {
      bg: '#272822',
      surface: '#1e1f1c',
      elevated: '#3e3d32',
      text: '#f8f8f2',
      muted: '#a59f85',
      accent: '#a6e22e',
      accentText: '#272822',
      border: '#49483e',
      success: '#a6e22e',
      danger: '#f92672',
      warning: '#e6db74',
      info: '#66d9ef'
    }
  },
  {
    id: 'dracula',
    name: 'Dracula',
    dark: true,
    colors: {
      bg: '#282a36',
      surface: '#21222c',
      elevated: '#44475a',
      text: '#f8f8f2',
      muted: '#8f99c9',
      accent: '#bd93f9',
      accentText: '#282a36',
      border: '#44475a',
      success: '#50fa7b',
      danger: '#ff5555',
      warning: '#f1fa8c',
      info: '#8be9fd'
    }
  },
  {
    id: 'tokyonight',
    name: 'Tokyo Night',
    dark: true,
    colors: {
      bg: '#1a1b26',
      surface: '#16161e',
      elevated: '#24283b',
      text: '#c0caf5',
      muted: '#737aa2',
      accent: '#7aa2f7',
      accentText: '#1a1b26',
      border: '#2f334d',
      success: '#9ece6a',
      danger: '#f7768e',
      warning: '#e0af68',
      info: '#7dcfff'
    }
  },
  {
    id: 'catppuccin',
    name: 'Catppuccin Mocha',
    dark: true,
    colors: {
      bg: '#1e1e2e',
      surface: '#181825',
      elevated: '#313244',
      text: '#cdd6f4',
      muted: '#a6adc8',
      accent: '#cba6f7',
      accentText: '#1e1e2e',
      border: '#45475a',
      success: '#a6e3a1',
      danger: '#f38ba8',
      warning: '#f9e2af',
      info: '#89b4fa'
    }
  },
  {
    id: 'synthwave',
    name: 'Synthwave',
    dark: true,
    colors: {
      bg: '#262335',
      surface: '#1e1b29',
      elevated: '#34294f',
      text: '#ffffff',
      muted: '#a59bc2',
      accent: '#ff7edb',
      accentText: '#262335',
      border: '#4a3d6b',
      success: '#72f1b8',
      danger: '#fe4450',
      warning: '#fede5d',
      info: '#36f9f6'
    }
  },
  {
    id: 'rosepine',
    name: 'Rosé Pine',
    dark: true,
    colors: {
      bg: '#191724',
      surface: '#1f1d2e',
      elevated: '#26233a',
      text: '#e0def4',
      muted: '#908caa',
      accent: '#c4a7e7',
      accentText: '#191724',
      border: '#403d52',
      success: '#9ccfd8',
      danger: '#eb6f92',
      warning: '#f6c177',
      info: '#31748f'
    }
  },
  {
    id: 'cyberpunk',
    name: 'Cyberpunk',
    dark: true,
    colors: {
      bg: '#000000',
      surface: '#0d0d0d',
      elevated: '#1a1a1a',
      text: '#00ff9f',
      muted: '#00b8ff',
      accent: '#d600ff',
      accentText: '#ffffff',
      border: '#001eff',
      success: '#00ff9f',
      danger: '#ff2e63',
      warning: '#bd00ff',
      info: '#00b8ff'
    }
  },
  {
    id: 'cyberpunk-rain',
    name: 'Cyberpunk Rain',
    dark: true,
    colors: {
      bg: '#1e0f1d',
      surface: '#061f2b',
      elevated: '#061f2b',
      text: '#467fa1',
      muted: '#7a4a83',
      accent: '#5e0b0b',
      accentText: '#ffffff',
      border: '#54295c',
      success: '#467fa1',
      danger: '#b3261e',
      warning: '#8a5a9c',
      info: '#467fa1'
    }
  }
]

export function findTheme(id: string): Theme | undefined {
  return THEMES.find((theme) => theme.id === id)
}

/** Resolve a theme id (including "system") to a concrete theme. */
export function resolveTheme(id: string, prefersDark: boolean): Theme {
  if (id !== SYSTEM_THEME_ID) {
    const theme = findTheme(id)
    if (theme) return theme
  }
  return findTheme(prefersDark ? 'adwaita-dark' : 'adwaita') as Theme
}
