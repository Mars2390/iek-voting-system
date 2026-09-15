// Engineer Hub — Flutter setup smoke test.
//
// Paste this over `lib/main.dart` in a fresh `flutter create` project.
// It renders "Hello World" AND verifies the toolchain can reach the live
// Engineer Hub API, so one run proves: SDK + emulator + networking all work.
//
// Requires one package:
//   flutter pub add http
//
// Optional: point at a different backend without editing code:
//   flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

/// Base URL of the Engineer Hub API.
///
/// On the Android emulator, `localhost` refers to the emulator itself — use
/// `http://10.0.2.2:<port>` to reach a dev server on your Windows machine.
const String apiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'https://www.engineerhuub.com',
);

void main() => runApp(const EngineerHubSetupCheck());

class EngineerHubSetupCheck extends StatelessWidget {
  const EngineerHubSetupCheck({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Engineer Hub — Setup Check',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF006600)),
        useMaterial3: true,
      ),
      home: const HomePage(),
    );
  }
}

/// Result of the connectivity probe, so the UI can render each state without
/// juggling three loose nullable fields.
sealed class ProbeState {
  const ProbeState();
}

class ProbeIdle extends ProbeState {
  const ProbeIdle();
}

class ProbeLoading extends ProbeState {
  const ProbeLoading();
}

class ProbeSuccess extends ProbeState {
  const ProbeSuccess(this.statusCode, this.body);
  final int statusCode;
  final String body;
}

class ProbeFailure extends ProbeState {
  const ProbeFailure(this.message);
  final String message;
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  ProbeState _state = const ProbeIdle();

  Future<void> _checkApi() async {
    setState(() => _state = const ProbeLoading());

    final uri = Uri.parse('$apiBaseUrl/api/election-status');

    try {
      final response = await http
          .get(uri, headers: const {'Accept': 'application/json'})
          .timeout(const Duration(seconds: 10));

      if (response.statusCode != 200) {
        throw HttpException(
          'Server returned HTTP ${response.statusCode}',
        );
      }

      // Decode so a 200 carrying HTML (e.g. a proxy error page) still fails loudly.
      final decoded = jsonDecode(response.body);
      final pretty = const JsonEncoder.withIndent('  ').convert(decoded);

      if (!mounted) return;
      setState(() => _state = ProbeSuccess(response.statusCode, pretty));
    } on TimeoutException {
      if (!mounted) return;
      setState(() => _state = const ProbeFailure(
            'Request timed out after 10s. Check the emulator has internet '
            '(open its browser) and that API_BASE_URL is reachable.',
          ));
    } on FormatException catch (error) {
      if (!mounted) return;
      setState(() => _state =
          ProbeFailure('Response was not valid JSON: ${error.message}'));
    } catch (error) {
      if (!mounted) return;
      setState(() => _state = ProbeFailure('$error'));
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Engineer Hub'),
        backgroundColor: theme.colorScheme.inversePrimary,
      ),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text('Hello World',
                  style: theme.textTheme.displaySmall
                      ?.copyWith(fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              Text(
                'Flutter toolchain is working.',
                style: theme.textTheme.bodyLarge,
              ),
              const SizedBox(height: 32),
              FilledButton.icon(
                onPressed: _state is ProbeLoading ? null : _checkApi,
                icon: const Icon(Icons.cloud_sync_outlined),
                label: const Text('Test Engineer Hub API'),
              ),
              const SizedBox(height: 8),
              Text(apiBaseUrl, style: theme.textTheme.bodySmall),
              const SizedBox(height: 24),
              _ResultCard(state: _state),
            ],
          ),
        ),
      ),
    );
  }
}

class _ResultCard extends StatelessWidget {
  const _ResultCard({required this.state});

  final ProbeState state;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return switch (state) {
      ProbeIdle() => const SizedBox.shrink(),
      ProbeLoading() => const Padding(
          padding: EdgeInsets.all(16),
          child: CircularProgressIndicator(),
        ),
      ProbeSuccess(:final statusCode, :final body) => Card(
          color: theme.colorScheme.secondaryContainer,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Icon(Icons.check_circle, color: Colors.green),
                    const SizedBox(width: 8),
                    Text('HTTP $statusCode — API reachable',
                        style: theme.textTheme.titleMedium),
                  ],
                ),
                const SizedBox(height: 12),
                SelectableText(body,
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
              ],
            ),
          ),
        ),
      ProbeFailure(:final message) => Card(
          color: theme.colorScheme.errorContainer,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.error_outline, color: theme.colorScheme.error),
                const SizedBox(width: 8),
                Expanded(child: SelectableText(message)),
              ],
            ),
          ),
        ),
    };
  }
}

class HttpException implements Exception {
  const HttpException(this.message);
  final String message;

  @override
  String toString() => message;
}
