import type { VariantProps } from 'class-variance-authority';
import { cva } from 'class-variance-authority';

export { default as Item } from './Item.vue';
export { default as ItemGroup } from './ItemGroup.vue';
export { default as ItemSeparator } from './ItemSeparator.vue';
export { default as ItemMedia } from './ItemMedia.vue';
export { default as ItemContent } from './ItemContent.vue';
export { default as ItemTitle } from './ItemTitle.vue';
export { default as ItemDescription } from './ItemDescription.vue';
export { default as ItemActions } from './ItemActions.vue';

export const itemVariants = cva(
  'group/item flex flex-wrap items-center rounded-md border border-transparent text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline: 'border-border',
        muted: 'bg-muted/50',
      },
      size: {
        default: 'gap-4 p-4',
        sm: 'gap-2.5 px-4 py-3',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);
export type ItemVariants = VariantProps<typeof itemVariants>;

export const itemMediaVariants = cva(
  'flex shrink-0 items-center justify-center gap-2 group-has-[[data-slot=item-description]]/item:self-start group-has-[[data-slot=item-description]]/item:translate-y-0.5 [&_svg]:pointer-events-none',
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        icon: 'size-8 rounded-sm border bg-muted [&_svg:not([class*=size-])]:size-4',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);
export type ItemMediaVariants = VariantProps<typeof itemMediaVariants>;
