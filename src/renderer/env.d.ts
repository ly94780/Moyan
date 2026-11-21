import type { DesktopAPI } from '../shared/types';
declare global {
  interface Window {
    desktop: DesktopAPI;
  }
}
declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}
