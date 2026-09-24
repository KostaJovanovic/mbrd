package com.valjdakosta.mbrd;

import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.view.Display;
import android.view.FrameMetrics;
import android.view.Window;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * The benchmark's half in the shell (web/assets/js/perf/bench.ts): the
 * window's own frame timings, and a place for the result. Desktop twin: the
 * bench:save handler in desktop/main.ts, which has no frames to give, since
 * the desktop's rAF is already paced by presented frames.
 *
 * FrameMetrics rather than SurfaceFlinger: the app can read it with no adb and
 * no permission, and it is the stream dumpsys gfxinfo reads, which on the
 * S22+ matched SurfaceFlinger frame for frame - the WebView draws on the
 * window's render thread, so its frames are the window's.
 */
@CapacitorPlugin(name = "MbrdBench")
public class MbrdBench extends Plugin {

    /** A result's name, as benchFileName() makes it. Nothing else is written. */
    private static final Pattern NAME = Pattern.compile("^mbrd-bench-[a-z0-9.-]{1,160}\\.json$");
    /** Two minutes at 120 Hz, with room over. A scenario is seconds long. */
    private static final int MAX_FRAMES = 20000;

    private final Object lock = new Object();
    private final List<double[]> frames = new ArrayList<>();
    private Window.OnFrameMetricsAvailableListener listener;
    private HandlerThread thread;

    /** Start collecting. A second start begins again from nothing. */
    @PluginMethod
    public void start(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                detach();
                synchronized (lock) { frames.clear(); }
                thread = new HandlerThread("mbrd-frame-metrics");
                thread.start();
                final double fallback = 1000.0 / refreshHz();
                listener = (window, metrics, dropped) -> {
                    // Nanoseconds in, milliseconds out: the page reads ms.
                    double vsync = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        ? metrics.getMetric(FrameMetrics.VSYNC_TIMESTAMP) / 1e6 : 0;
                    double total = metrics.getMetric(FrameMetrics.TOTAL_DURATION) / 1e6;
                    double deadline = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                        ? metrics.getMetric(FrameMetrics.DEADLINE) / 1e6 : fallback;
                    synchronized (lock) {
                        if (frames.size() < MAX_FRAMES) frames.add(new double[] { vsync, total, deadline });
                    }
                };
                getActivity().getWindow().addOnFrameMetricsAvailableListener(listener, new Handler(thread.getLooper()));
                call.resolve();
            } catch (RuntimeException e) {
                detach();
                call.reject("frame metrics are not available: " + e.getMessage());
            }
        });
    }

    /** Stop, and hand over what was collected, with the rate the display claims. */
    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            detach();
            JSArray list = new JSArray();
            synchronized (lock) {
                double first = frames.isEmpty() ? 0 : frames.get(0)[0];
                for (double[] f : frames) {
                    JSObject o = new JSObject();
                    // From the first frame, so the numbers stay small in the file.
                    o.put("vsync", f[0] - first);
                    o.put("total", f[1]);
                    o.put("deadline", f[2]);
                    list.put(o);
                }
                frames.clear();
            }
            JSObject r = new JSObject();
            r.put("refreshHz", refreshHz());
            r.put("frames", list);
            call.resolve(r);
        });
    }

    /** Write a result into bench/ in the boards folder, and answer its path. */
    @PluginMethod
    public void save(PluginCall call) {
        String name = call.getString("name");
        String json = call.getString("json");
        if (name == null || json == null || !NAME.matcher(name).matches()) {
            call.reject("not a benchmark result's name");
            return;
        }
        new Thread(() -> {
            try {
                File dir = new File(MbrdBoards.folder(), "bench");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("could not make " + dir);
                File to;
                synchronized (MbrdBoards.NAMES) {
                    to = new File(dir, MbrdNames.freeName(dir, name));
                    File temp = new File(dir, "." + to.getName() + ".part");
                    try (FileOutputStream out = new FileOutputStream(temp)) {
                        out.write(json.getBytes(StandardCharsets.UTF_8));
                        out.getFD().sync();
                    }
                    if (!temp.renameTo(to)) {
                        //noinspection ResultOfMethodCallIgnored
                        temp.delete();
                        throw new IOException("could not write " + to.getName());
                    }
                }
                JSObject r = new JSObject();
                r.put("path", to.getPath());
                call.resolve(r);
            } catch (IOException | RuntimeException e) {
                call.reject(e.getMessage());
            }
        }, "mbrd-bench-save").start();
    }

    @Override
    protected void handleOnDestroy() {
        detach();
    }

    private void detach() {
        if (listener != null) {
            try {
                getActivity().getWindow().removeOnFrameMetricsAvailableListener(listener);
            } catch (RuntimeException ignored) {
                // Already gone with the window.
            }
            listener = null;
        }
        if (thread != null) {
            thread.quitSafely();
            thread = null;
        }
    }

    @SuppressWarnings("deprecation")
    private double refreshHz() {
        Display display = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
            ? getActivity().getDisplay()
            : getActivity().getWindowManager().getDefaultDisplay();
        float hz = display == null ? 0 : display.getRefreshRate();
        return hz > 0 ? hz : 60;
    }
}
