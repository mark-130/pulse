import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex min-h-11 items-center justify-center rounded-full px-5 text-[15px] font-semibold disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-foreground",
        secondary: "border border-border-strong bg-surface-2 text-foreground",
        /** Destructive changes. Rose from the state tokens, never colour alone: the label says what is removed. */
        danger: "bg-danger text-accent-foreground",
      },
    },
    defaultVariants: { variant: "primary" },
  },
);

export function Button({
  className,
  variant,
  asChild,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant }), className)} {...props} />;
}

export function Card({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("card", className)}>
      <h2 className="t-card-title mb-2">{title}</h2>
      {children}
    </section>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="t-secondary">{children}</p>;
}
