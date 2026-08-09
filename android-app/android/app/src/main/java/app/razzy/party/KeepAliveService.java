package app.razzy.party;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * Does nothing except exist.
 *
 * Android is free to freeze or kill a backgrounded app, which for a watch party
 * means the socket dies, playback drifts out of sync, and a friend's call never
 * rings. A foreground service holds the process in a bucket the system won't
 * reclaim. It carries no logic of its own — everything still happens in the
 * WebView; this is only what stops that WebView being put to sleep.
 *
 * It runs only while you are in a party, and it says so in the shade, because a
 * background service you can't see is a battery complaint waiting to happen.
 */
public class KeepAliveService extends Service {

    public static final String CHANNEL = "razzy.party";
    private static final int ID = 4201;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String code = intent != null ? intent.getStringExtra("code") : null;

        PendingIntent open = PendingIntent.getActivity(
            this, 0,
            new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE
        );

        Notification note = new NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle(code == null ? "Razzy" : "Watching party " + code)
            .setContentText("Keeping you in sync")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(open)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(ID, note, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(ID, note);
        }
        // If the system does kill us, come back — but without redelivering the
        // old intent, since the party code may well have changed by then.
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
