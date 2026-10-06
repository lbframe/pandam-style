import { create, props, recipes, token } from '../generated/design.pandamstyle';

const styles = create({
  control: {
    display: 'inline-flex',
    gap: token('spacing.sm'),
  },
});

const button = recipes.button!({ variant: 'primary', size: 'md' });

export function ForwardedControl(attributes: Record<string, unknown>) {
  const { className, style, ...nativeAttributes } = attributes;
  void className;
  void style;
  return (
    <button {...props(button, styles.control)} {...nativeAttributes}>
      Continue
    </button>
  );
}

export function ForwardedParameter({ className, style, ...attributes }: Record<string, unknown>) {
  void className;
  void style;
  return <button {...attributes}>Continue</button>;
}

export const ForwardedArrowParameter = ({
  className,
  style,
  ...attributes
}: Record<string, unknown>) => {
  void className;
  void style;
  return <button {...attributes}>Continue</button>;
};
