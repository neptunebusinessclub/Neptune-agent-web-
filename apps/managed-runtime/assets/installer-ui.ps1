param(
  [Parameter(Mandatory = $true)][string]$InstallScript,
  [Parameter(Mandatory = $true)][string]$HostSource,
  [Parameter(Mandatory = $true)][string]$StartScriptSource,
  [Parameter(Mandatory = $true)][string]$StoreUrl,
  [Parameter(Mandatory = $true)][string]$SetupPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Neptune" Width="620" Height="500" WindowStartupLocation="CenterScreen"
        ResizeMode="NoResize" Background="#070A14" Foreground="#F7F8FF"
        FontFamily="Segoe UI" ShowInTaskbar="True">
  <Window.Resources>
    <LinearGradientBrush x:Key="NeptuneGradient" StartPoint="0,0" EndPoint="1,1">
      <GradientStop Color="#2F8CFF" Offset="0" />
      <GradientStop Color="#7B4DFF" Offset="0.55" />
      <GradientStop Color="#D744FF" Offset="1" />
    </LinearGradientBrush>
    <Style TargetType="Button">
      <Setter Property="Foreground" Value="White" />
      <Setter Property="Background" Value="{StaticResource NeptuneGradient}" />
      <Setter Property="BorderThickness" Value="0" />
      <Setter Property="Padding" Value="22,12" />
      <Setter Property="FontWeight" Value="SemiBold" />
      <Setter Property="Cursor" Value="Hand" />
      <Setter Property="MinWidth" Value="160" />
    </Style>
  </Window.Resources>
  <Grid Margin="34">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto" />
      <RowDefinition Height="Auto" />
      <RowDefinition Height="Auto" />
      <RowDefinition Height="*" />
      <RowDefinition Height="Auto" />
    </Grid.RowDefinitions>

    <StackPanel Grid.Row="0" Orientation="Horizontal">
      <Border Width="58" Height="58" CornerRadius="18" Background="{StaticResource NeptuneGradient}">
        <TextBlock Text="N" FontSize="31" FontWeight="Bold" HorizontalAlignment="Center" VerticalAlignment="Center" />
      </Border>
      <StackPanel Margin="18,2,0,0">
        <TextBlock Text="NEPTUNE" FontSize="13" FontWeight="Bold" Foreground="#9FAEFF" />
        <TextBlock Text="Installation intelligente" FontSize="27" FontWeight="SemiBold" />
      </StackPanel>
    </StackPanel>

    <TextBlock Grid.Row="1" x:Name="StatusText" Margin="0,34,0,8" FontSize="21" FontWeight="SemiBold" Text="Préparation de votre assistant…" />
    <TextBlock Grid.Row="2" x:Name="DetailText" Foreground="#AEB5CA" FontSize="14" TextWrapping="Wrap" Text="Neptune vérifie votre ordinateur et prépare automatiquement son moteur local." />

    <StackPanel Grid.Row="3" Margin="0,30,0,0">
      <ProgressBar x:Name="Progress" Height="9" Minimum="0" Maximum="100" Value="4" Foreground="#7B4DFF" Background="#1A2033" BorderThickness="0" />
      <Border Margin="0,26,0,0" Padding="18" Background="#101526" CornerRadius="14">
        <StackPanel>
          <TextBlock Text="INSTALLATION SÉCURISÉE" FontSize="11" FontWeight="Bold" Foreground="#8C9BCA" />
          <TextBlock x:Name="StepText" Margin="0,8,0,0" FontSize="14" TextWrapping="Wrap" Text="Initialisation…" />
        </StackPanel>
      </Border>
      <TextBlock x:Name="Footnote" Margin="0,18,0,0" Foreground="#747F9E" FontSize="12" TextWrapping="Wrap"
                 Text="Aucune clé API, commande terminal ou configuration technique ne vous sera demandée." />
    </StackPanel>

    <StackPanel Grid.Row="4" Margin="0,24,0,0" Orientation="Horizontal" HorizontalAlignment="Right">
      <Button x:Name="SecondaryButton" Margin="0,0,12,0" Background="#242B41" Content="Fermer" IsEnabled="False" />
      <Button x:Name="PrimaryButton" Content="Installation en cours…" IsEnabled="False" />
    </StackPanel>
  </Grid>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
$statusText = $window.FindName('StatusText')
$detailText = $window.FindName('DetailText')
$stepText = $window.FindName('StepText')
$progress = $window.FindName('Progress')
$primaryButton = $window.FindName('PrimaryButton')
$secondaryButton = $window.FindName('SecondaryButton')
$footnote = $window.FindName('Footnote')

$logRoot = Join-Path $env:LOCALAPPDATA 'Neptune\Installer'
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$stdoutPath = Join-Path $logRoot 'latest-output.log'
$stderrPath = Join-Path $logRoot 'latest-error.log'
Remove-Item $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue

function Quote-Argument([string]$value) {
  return '"' + ($value -replace '"', '\"') + '"'
}

$arguments = @(
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', (Quote-Argument $InstallScript),
  '-HostSource', (Quote-Argument $HostSource),
  '-StartScriptSource', (Quote-Argument $StartScriptSource)
) -join ' '

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = 'powershell.exe'
$startInfo.Arguments = $arguments
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
$startInfo.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $startInfo
$queue = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
$errorQueue = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
$process.add_OutputDataReceived({ param($sender, $eventArgs) if ($eventArgs.Data) { $queue.Enqueue($eventArgs.Data) } })
$process.add_ErrorDataReceived({ param($sender, $eventArgs) if ($eventArgs.Data) { $errorQueue.Enqueue($eventArgs.Data) } })

$script:completed = $false
$script:storeOpened = $false
$script:exitCode = 1
$script:allowClose = $false

function Set-FriendlyStep([string]$line) {
  if ([string]::IsNullOrWhiteSpace($line)) { return }
  Add-Content -Path $stdoutPath -Value $line -Encoding UTF8

  switch -Regex ($line) {
    'Mémoire installée détectée' {
      $progress.Value = 12
      $statusText.Text = 'Ordinateur compatible'
      $stepText.Text = 'Neptune adapte automatiquement son moteur aux ressources disponibles.'
      break
    }
    'Installation du moteur Hermes|Réparation automatique de la tentative' {
      $progress.Value = 24
      $statusText.Text = 'Installation du moteur Neptune'
      $stepText.Text = 'Préparation du moteur agentique et de sa mémoire locale.'
      break
    }
    'Installation des moteurs locaux' {
      $progress.Value = 42
      $statusText.Text = 'Optimisation pour votre ordinateur'
      $stepText.Text = 'Installation des profils accéléré et universel.'
      break
    }
    'Téléchargement du cerveau local' {
      $progress.Value = 58
      $statusText.Text = 'Téléchargement de l’intelligence locale'
      $stepText.Text = 'Environ 2,5 Go. Le téléchargement peut prendre plusieurs minutes.'
      break
    }
    'Configuration automatique' {
      $progress.Value = 72
      $statusText.Text = 'Configuration automatique'
      $stepText.Text = 'Création de la mémoire et de la liaison sécurisée.'
      break
    }
    'Enregistrement sécurisé' {
      $progress.Value = 84
      $statusText.Text = 'Connexion à Chrome'
      $stepText.Text = 'Enregistrement du pont local sécurisé.'
      break
    }
    'Démarrage et validation' {
      $progress.Value = 92
      $statusText.Text = 'Vérification finale'
      $stepText.Text = 'Neptune démarre son moteur et contrôle son état.'
      break
    }
    'installé et opérationnel|profil local compatible' {
      $progress.Value = 100
      $statusText.Text = 'Neptune est prêt'
      $stepText.Text = 'Le moteur local est installé, supervisé et prêt à être utilisé.'
      break
    }
  }
}

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(220)
$timer.add_Tick({
  $line = $null
  while ($queue.TryDequeue([ref]$line)) { Set-FriendlyStep $line }
  while ($errorQueue.TryDequeue([ref]$line)) { Add-Content -Path $stderrPath -Value $line -Encoding UTF8 }

  if (-not $script:completed -and $process.HasExited) {
    $script:completed = $true
    $script:exitCode = $process.ExitCode
    $timer.Stop()
    $process.WaitForExit()
    while ($queue.TryDequeue([ref]$line)) { Set-FriendlyStep $line }
    while ($errorQueue.TryDequeue([ref]$line)) { Add-Content -Path $stderrPath -Value $line -Encoding UTF8 }

    $secondaryButton.IsEnabled = $true
    if ($script:exitCode -eq 0) {
      $progress.Value = 100
      $statusText.Text = 'Installation terminée'
      $detailText.Text = 'Le moteur Neptune est opérationnel. Il reste uniquement à confirmer son ajout dans Chrome.'
      $stepText.Text = 'Chrome va ouvrir la fiche officielle Neptune. Cliquez sur « Ajouter à Chrome », puis ouvrez Neptune depuis l’icône Extensions.'
      $footnote.Text = 'Cette confirmation Chrome est la seule action requise après l’installation.'
      $primaryButton.Content = 'Ajouter Neptune à Chrome'
      $primaryButton.IsEnabled = $true
      if (-not $script:storeOpened) {
        $script:storeOpened = $true
        Start-Process $StoreUrl -ErrorAction SilentlyContinue
      }
    } else {
      $statusText.Text = 'Neptune n’a pas pu terminer l’installation'
      $detailText.Text = 'Aucune configuration manuelle n’est nécessaire. Le bouton ci-dessous relance une installation propre et réutilise les éléments valides.'
      $stepText.Text = "Le diagnostic a été enregistré dans : $logRoot"
      $footnote.Text = 'Le support Neptune peut utiliser ces journaux sans vous demander de commandes techniques.'
      $primaryButton.Content = 'Réessayer automatiquement'
      $primaryButton.IsEnabled = $true
    }
  }
})

$primaryButton.add_Click({
  if (-not $script:completed) { return }
  if ($script:exitCode -eq 0) {
    Start-Process $StoreUrl -ErrorAction SilentlyContinue
  } else {
    $script:allowClose = $true
    $window.Close()
    Start-Process -FilePath $SetupPath -ErrorAction SilentlyContinue
  }
})
$secondaryButton.add_Click({ $script:allowClose = $true; $window.Close() })
$window.add_Closing({
  param($sender, $eventArgs)
  if ($script:allowClose) { return }
  if (-not $script:completed -and -not $process.HasExited) {
    $answer = [System.Windows.MessageBox]::Show('L’installation est encore en cours. Voulez-vous vraiment l’interrompre ?', 'Neptune', 'YesNo', 'Warning')
    if ($answer -ne 'Yes') { $eventArgs.Cancel = $true; return }
    try { $process.Kill() } catch { }
  }
})

if (-not $process.Start()) { throw 'Impossible de démarrer le programme d’installation Neptune.' }
$process.BeginOutputReadLine()
$process.BeginErrorReadLine()
$timer.Start()
[void]$window.ShowDialog()
exit $script:exitCode
