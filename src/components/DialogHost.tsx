import { HelpDialog, McpDialog, ShareDialog, VariantsDialog } from "./CommandDialog";
import ConnectDialog from "./ConnectDialog";
import type { useOpencode } from "../hooks/useOpencode";

type Oc = ReturnType<typeof useOpencode>;

// renders whichever `oc.dialog` is open (slash-command driven)
export default function DialogHost({ oc }: { oc: Oc }) {
  switch (oc.dialog?.kind) {
    case "help":
      return <HelpDialog commands={oc.cmdList} onClose={oc.closeDialog} />;
    case "share":
      return <ShareDialog url={oc.dialog.url} onClose={oc.closeDialog} />;
    case "variants":
      return (
        <VariantsDialog
          variants={oc.modelVariants}
          selected={oc.variantSel}
          onSelect={oc.setVariantSel}
          onClose={oc.closeDialog}
        />
      );
    case "mcp":
      return <McpDialog onClose={oc.closeDialog} />;
    case "connect":
      return <ConnectDialog onClose={oc.closeDialog} onConnected={() => void (oc as any).refreshProviders?.()} />;
    default:
      return null;
  }
}
