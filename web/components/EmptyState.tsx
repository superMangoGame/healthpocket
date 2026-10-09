import { FileArrowUp } from "@phosphor-icons/react/dist/ssr";

export function EmptyState({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="empty-state">
      <FileArrowUp size={36} weight="thin" />
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

