/**
 * A literal invalid variant fails at build time, before any style is emitted.
 */
import { recipes, props } from '../generated/design.pandamstyle';

export const button = props(recipes.button({ variant: 'huge', size: 'md' }));
