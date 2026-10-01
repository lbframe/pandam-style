/**
 * A page that imports only a recipe: it must still be covered, and the
 * selection is static so it is validated at build time.
 */
import { recipes, props } from '../generated/design.pandamstyle';

export const primaryButton = props(
  recipes.button({ variant: 'primary', size: 'md' }),
);
export const secondaryButton = props(
  recipes.button({ variant: 'secondary', size: 'sm' }),
);
