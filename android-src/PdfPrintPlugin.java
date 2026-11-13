package com.jean.editorpdf;

import android.content.Context;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.print.PrintManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

@CapacitorPlugin(name = "PdfPrint")
public class PdfPrintPlugin extends Plugin {

    @PluginMethod
    public void print(final PluginCall call) {
        final String path = call.getString("path");
        final String name = call.getString("name", "documento.pdf");
        if (path == null) {
            call.reject("Caminho do arquivo ausente");
            return;
        }
        final File file = new File(path);
        if (!file.exists()) {
            call.reject("Arquivo não encontrado");
            return;
        }
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    PrintManager pm = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                    pm.print(name, new PrintDocumentAdapter() {
                        @Override
                        public void onLayout(PrintAttributes oldAttrs, PrintAttributes newAttrs,
                                             CancellationSignal signal, LayoutResultCallback callback, Bundle extras) {
                            if (signal.isCanceled()) {
                                callback.onLayoutCancelled();
                                return;
                            }
                            PrintDocumentInfo info = new PrintDocumentInfo.Builder(name)
                                    .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                                    .setPageCount(PrintDocumentInfo.PAGE_COUNT_UNKNOWN)
                                    .build();
                            callback.onLayoutFinished(info, true);
                        }

                        @Override
                        public void onWrite(PageRange[] pages, ParcelFileDescriptor destination,
                                            CancellationSignal signal, WriteResultCallback callback) {
                            InputStream in = null;
                            OutputStream out = null;
                            try {
                                in = new FileInputStream(file);
                                out = new FileOutputStream(destination.getFileDescriptor());
                                byte[] buf = new byte[16384];
                                int n;
                                while ((n = in.read(buf)) > 0) {
                                    out.write(buf, 0, n);
                                }
                                callback.onWriteFinished(new PageRange[]{PageRange.ALL_PAGES});
                            } catch (Exception e) {
                                callback.onWriteFailed(e.toString());
                            } finally {
                                try { if (in != null) in.close(); } catch (Exception ignored) {}
                                try { if (out != null) out.close(); } catch (Exception ignored) {}
                            }
                        }
                    }, null);
                    call.resolve();
                } catch (Exception e) {
                    call.reject("Erro ao imprimir: " + e.getMessage());
                }
            }
        });
    }
}
