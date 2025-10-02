export const windowControl: {
  closeWindow: () => Promise<any>
} = {
  closeWindow: () => (window as any).windowControls.close()
}
