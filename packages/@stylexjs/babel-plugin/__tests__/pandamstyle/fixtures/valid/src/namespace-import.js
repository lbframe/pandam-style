/** Namespace import of the design system. */
import * as pms from '../generated/design.pandamstyle';

export const styles = pms.create({
  block: {
    padding: pms.token('spacing.md'),
    opacity: 0.5,
    width: '100%',
  },
});

export const block = pms.props(pms.themes.dark, styles.block);
