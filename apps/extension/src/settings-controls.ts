export {};

document.addEventListener("change", (event) => {
  const target = event.target as HTMLSelectElement | null;
  if (!target) return;
  if (target.id === "advanced-local-model") {
    const button = document.querySelector<HTMLButtonElement>("button[data-action='select-local-model']");
    if (!button) return;
    button.dataset.value = target.value;
    button.click();
    return;
  }
  if (target.id === "advanced-provider") {
    const button = document.querySelector<HTMLButtonElement>(`button[data-action='select-provider'][data-value='${CSS.escape(target.value)}']`);
    button?.click();
  }
});
