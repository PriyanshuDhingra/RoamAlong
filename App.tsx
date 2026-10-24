import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import * as Location from "expo-location";
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from "expo-audio";

const DEFAULT_WEB_URL =
  process.env.EXPO_PUBLIC_WEB_URL || "http://localhost:5173";

export default function App() {
  const webViewRef = useRef<WebView<object> | null>(null);
  const [permissionsReady, setPermissionsReady] = useState(false);
  const headingRef = useRef<number>(0);

  useEffect(() => {
    let locationSub: Location.LocationSubscription | null = null;
    let headingSub: Location.LocationSubscription | null = null;
    let mounted = true;

    async function setupNativePermissionsAndSensors() {
      try {
        // Native microphone permission plus a record-capable audio session that ignores the silent switch
        await requestRecordingPermissionsAsync();
        await setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
        });
      } catch {
        // Continue even if audio mode setup has minor platform warnings
      }

      try {
        // 2. Request native OS foreground location permission & stream GPS + Compass into the WebView
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === "granted" && mounted) {
          headingSub = await Location.watchHeadingAsync((headingObj) => {
            const deg =
              headingObj.trueHeading >= 0
                ? headingObj.trueHeading
                : headingObj.magHeading;
            if (typeof deg === "number" && !Number.isNaN(deg)) {
              headingRef.current = Math.round(deg) % 360;
            }
          });

          locationSub = await Location.watchPositionAsync(
            {
              accuracy: Location.Accuracy.BestForNavigation,
              timeInterval: 1200,
              distanceInterval: 3,
            },
            (pos) => {
              const payload = JSON.stringify({
                type: "EXPO_NATIVE_LOCATION",
                lat: pos.coords.latitude,
                lon: pos.coords.longitude,
                headingDeg:
                  typeof pos.coords.heading === "number" &&
                  pos.coords.heading >= 0
                    ? Math.round(pos.coords.heading)
                    : headingRef.current,
                speedMps:
                  typeof pos.coords.speed === "number" && pos.coords.speed >= 0
                    ? Number(pos.coords.speed.toFixed(2))
                    : 0.8,
              });
              webViewRef.current?.postMessage(payload);
            }
          );
        }
      } catch {
        // Ignore location watch errors if running in simulator without location
      }

      if (mounted) {
        setPermissionsReady(true);
      }
    }

    void setupNativePermissionsAndSensors();

    return () => {
      mounted = false;
      locationSub?.remove();
      headingSub?.remove();
    };
  }, []);

  if (!permissionsReady) {
    return (
      <SafeAreaView style={styles.loadingContainer}>
        <StatusBar barStyle="dark-content" />
        <ActivityIndicator size="large" color="#1a73e8" />
        <Text style={styles.loadingText}>Starting Handheld Audio Tour…</Text>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" />
      {/* react-native-webview defaults its prop generic to `undefined`, which collapses props to `never` */}
      <WebView<object>
        ref={webViewRef}
        source={{ uri: DEFAULT_WEB_URL }}
        style={styles.webview}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        geolocationEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        mediaCapturePermissionGrantType="grant"
        startInLoadingState
        renderLoading={() => (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator size="large" color="#1a73e8" />
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f8f4f0",
    paddingTop: Platform.OS === "android" ? StatusBar.currentHeight ?? 0 : 0,
  },
  webview: {
    flex: 1,
    backgroundColor: "#f8f4f0",
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: "#f8f4f0",
    alignItems: "center",
    justifyContent: "center",
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "#f8f4f0",
    alignItems: "center",
    justifyContent: "center",
  },
  loadingText: {
    marginTop: 12,
    fontSize: 15,
    color: "#334155",
    fontWeight: "600",
  },
});
