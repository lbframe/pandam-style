/**
 * Renamed imports reached through the intermediate re-export. Recognition must
 * follow the binding and the module, not the textual name.
 */
import {
  create as pmsCreate,
  token as pmsToken,
  props as pmsProps,
  themes as pmsThemes,
} from './barrel.js';

export const styles = pmsCreate({
  panel: {
    padding: pmsToken('spacing.lg'),
    color: pmsToken('colors.text.primary'),
  },
});

export const panel = pmsProps(pmsThemes.light, styles.panel);
