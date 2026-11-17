import type { Cat, EntranceKind, FlowKind } from './types'

export interface CatColor {
  fill: string
  stroke: string
  ink: string
}

export interface Theme {
  id: string
  name: string
  dark: boolean
  /** シート（スライド）背景 */
  paper: string
  floor: string
  wall: string
  column: string
  fixed: string
  fixedInk: string
  ink: string
  sub: string
  grid: string
  line: string
  chair: string
  tableTop: string
  cat: Record<Cat, CatColor>
  flow: Record<FlowKind, string>
  door: Record<EntranceKind, string>
  fontJa: string
  fontEn: string
}

const light: Theme = {
  id: 'light',
  name: 'ライト',
  dark: false,
  paper: '#FFFFFF',
  floor: '#F7F6F1',
  wall: '#232A33',
  column: '#232A33',
  fixed: '#E3E5E8',
  fixedInk: '#5B6672',
  ink: '#1D252E',
  sub: '#6A7582',
  grid: '#E3E7EC',
  line: '#C9D0D8',
  chair: '#8EA2BA',
  tableTop: '#FFFFFF',
  cat: {
    production: { fill: '#2F3E5C', stroke: '#1E2A41', ink: '#FFFFFF' },
    seating: { fill: '#C9D5E2', stroke: '#7C92AD', ink: '#24364D' },
    exhibit: { fill: '#FBE9BC', stroke: '#C08A16', ink: '#5A3E00' },
    service: { fill: '#C4E6DD', stroke: '#27876F', ink: '#0E4A3E' },
    fnb: { fill: '#F9D2C5', stroke: '#CC5C3B', ink: '#6B2813' },
    staff: { fill: '#DDD6F0', stroke: '#7564AE', ink: '#382C63' },
    safety: { fill: '#F7CDCD', stroke: '#C24343', ink: '#681515' },
    zone: { fill: '#3B7FC4', stroke: '#3B7FC4', ink: '#1E4B78' },
    flow: { fill: '#2B6FD6', stroke: '#2B6FD6', ink: '#2B6FD6' },
    note: { fill: '#FFFFFF', stroke: '#6A7582', ink: '#1D252E' },
    structure: { fill: '#E3E5E8', stroke: '#232A33', ink: '#5B6672' },
  },
  flow: { visitor: '#2B6FD6', load: '#DE7A16', evac: '#1B9A56', staff: '#8656CF' },
  door: { entrance: '#2B6FD6', exit: '#2B6FD6', emergency: '#1B9A56', loading: '#DE7A16' },
  fontJa: 'Yu Gothic',
  fontEn: 'Yu Gothic',
}

const noir: Theme = {
  id: 'noir',
  name: 'ノワール×ゴールド',
  dark: true,
  paper: '#0D0B07',
  floor: '#17130C',
  wall: '#C9A66B',
  column: '#C9A66B',
  fixed: '#241E13',
  fixedInk: '#9C8B6A',
  ink: '#EFE7D4',
  sub: '#A99B7C',
  grid: '#262015',
  line: '#4A3F2A',
  chair: '#8C7F65',
  tableTop: '#2A2317',
  cat: {
    production: { fill: '#C9A66B', stroke: '#E6CD9B', ink: '#0D0B07' },
    seating: { fill: '#3A3222', stroke: '#8C7F65', ink: '#EFE7D4' },
    exhibit: { fill: '#2C2517', stroke: '#C9A66B', ink: '#EFE7D4' },
    service: { fill: '#EFE7D4', stroke: '#FFFFFF', ink: '#0D0B07' },
    fnb: { fill: '#70442A', stroke: '#C98A5E', ink: '#EFE7D4' },
    staff: { fill: '#2D2939', stroke: '#8F86B0', ink: '#EFE7D4' },
    safety: { fill: '#552020', stroke: '#D06A6A', ink: '#EFE7D4' },
    zone: { fill: '#C9A66B', stroke: '#C9A66B', ink: '#E6CD9B' },
    flow: { fill: '#EFE7D4', stroke: '#EFE7D4', ink: '#EFE7D4' },
    note: { fill: '#17130C', stroke: '#A99B7C', ink: '#EFE7D4' },
    structure: { fill: '#241E13', stroke: '#C9A66B', ink: '#9C8B6A' },
  },
  flow: { visitor: '#EFE7D4', load: '#E3A24F', evac: '#7FD0A0', staff: '#B8A6E8' },
  door: { entrance: '#EFE7D4', exit: '#EFE7D4', emergency: '#7FD0A0', loading: '#E3A24F' },
  fontJa: 'Yu Gothic',
  fontEn: 'Century Schoolbook',
}

const blueprint: Theme = {
  id: 'blueprint',
  name: 'ブループリント',
  dark: true,
  paper: '#0E3A70',
  floor: '#114483',
  wall: '#FFFFFF',
  column: '#FFFFFF',
  fixed: '#0C3466',
  fixedInk: '#BCD3F2',
  ink: '#FFFFFF',
  sub: '#BCD3F2',
  grid: '#1B509A',
  line: '#3A6DB3',
  chair: '#9BBBE6',
  tableTop: '#114483',
  cat: {
    production: { fill: '#FFFFFF', stroke: '#FFFFFF', ink: '#0E3A70' },
    seating: { fill: '#1A52A0', stroke: '#9BBBE6', ink: '#FFFFFF' },
    exhibit: { fill: '#184D96', stroke: '#FFFFFF', ink: '#FFFFFF' },
    service: { fill: '#CFE1F8', stroke: '#FFFFFF', ink: '#0E3A70' },
    fnb: { fill: '#2861AD', stroke: '#FFD9A0', ink: '#FFFFFF' },
    staff: { fill: '#19498B', stroke: '#D0C4FF', ink: '#FFFFFF' },
    safety: { fill: '#7E2C3A', stroke: '#FFB3B3', ink: '#FFFFFF' },
    zone: { fill: '#FFFFFF', stroke: '#FFFFFF', ink: '#FFFFFF' },
    flow: { fill: '#FFE08A', stroke: '#FFE08A', ink: '#FFE08A' },
    note: { fill: '#114483', stroke: '#BCD3F2', ink: '#FFFFFF' },
    structure: { fill: '#0C3466', stroke: '#FFFFFF', ink: '#BCD3F2' },
  },
  flow: { visitor: '#FFE08A', load: '#FFB36B', evac: '#9BE8B5', staff: '#D0C4FF' },
  door: { entrance: '#FFE08A', exit: '#FFE08A', emergency: '#9BE8B5', loading: '#FFB36B' },
  fontJa: 'Yu Gothic',
  fontEn: 'Yu Gothic',
}

export const THEMES: Record<string, Theme> = { light, noir, blueprint }
export const THEME_LIST = [light, noir, blueprint]
export const getTheme = (id?: string): Theme => THEMES[id || 'light'] || light
